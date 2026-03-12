import time
import json
import asyncio
import logging
import os
import threading
from datetime import datetime, timezone
from flask import request
from flask_socketio import emit
from app.models import Term, TermCategory, Meeting
from app.extensions import db
from app.services.volcano_translator import doubao_translator

# 全局会话字典 + 线程锁
sessions: dict[str, dict] = {}
sessions_lock = threading.Lock()

# 10分钟定时重连间隔
RECONNECT_INTERVAL = 600


def register_socket_handlers(socketio, app):

    @socketio.on('connect')
    def handle_connect():
        sid = request.sid
        app.logger.info(f'Client Connected: {sid}')

    @socketio.on('disconnect')
    def handle_disconnect():
        sid = request.sid
        app.logger.info(f'Client Disconnected: {sid}')
        with sessions_lock:
            if sid in sessions:
                sessions[sid]['stop_event'].set()
                loop = sessions[sid].get('loop')
                if loop and loop.is_running():
                    loop.call_soon_threadsafe(loop.stop)
                del sessions[sid]
                app.logger.info(f'Session {sid} cleaned up.')

    @socketio.on('update_glossary')
    def handle_update_glossary(data):
        sid = request.sid
        with sessions_lock:
            if sid not in sessions:
                return
            session_ref = sessions[sid]

        new_term = data.get('term')
        if not new_term:
            return

        try:
            with app.app_context():
                temp_cat_name = "临时术语"
                category = TermCategory.query.filter_by(name=temp_cat_name).first()

                if not category:
                    category = TermCategory(name=temp_cat_name, display_order=0)
                    db.session.add(category)
                    db.session.flush()

                exists = Term.query.filter_by(
                    category_id=category.id,
                    source=new_term['source']
                ).first()

                if not exists:
                    term_entry = Term(
                        source=new_term['source'],
                        target=new_term['target'],
                        category_id=category.id,
                        notes="会议中临时添加"
                    )
                    db.session.add(term_entry)
                    db.session.commit()
                    app.logger.info(f"Persisted temp term to DB: {new_term}")
                else:
                    exists.target = new_term['target']
                    db.session.commit()
                    app.logger.info(f"Updated existing temp term in DB: {new_term}")

        except Exception as e:
            app.logger.error(f"Failed to save temp term to DB: {e}")

        if 'glossary' not in session_ref['speak_config']:
            session_ref['speak_config']['glossary'] = {}
        if session_ref['listen_config'] and 'glossary' not in session_ref['listen_config']:
            session_ref['listen_config']['glossary'] = {}

        session_ref['speak_config']['glossary'][new_term['source']] = new_term['target']
        if session_ref['listen_config']:
            session_ref['listen_config']['glossary'][new_term['source']] = new_term['target']

        app.logger.info(f"Session {sid} added term to memory. Triggering Hot Reload...")
        if 'reload_event' in session_ref:
            session_ref['reload_event'].set()

    @socketio.on('start_session')
    def handle_start_session(data):
        sid = request.sid

        with sessions_lock:
            if sid in sessions and not sessions[sid]['stop_event'].is_set():
                app.logger.warning(f"Session {sid} already in progress")
                return

        speak_config = data.get('speak_config', {})
        category_ids = speak_config.get('category_ids', [])
        glossary_dict = {}

        if category_ids:
            all_selected_terms = Term.query.filter(
                Term.category_id.in_(category_ids)
            ).all()

            for term in all_selected_terms:
                if term.source and term.target:
                    glossary_dict[term.source] = term.target

            app.logger.info(f"Session {sid} loaded {len(glossary_dict)} terms")

        speak_config['glossary'] = glossary_dict

        loop = asyncio.new_event_loop()

        listen_config_data = data.get('listen_config')
        meeting = Meeting(
            title=datetime.now().strftime('%Y-%m-%d %H:%M') + ' 会议',
            start_time=datetime.now(timezone.utc),
            status='recording',
            speak_direction=speak_config.get('direction', ''),
            listen_direction=listen_config_data.get('direction', '') if listen_config_data else ''
        )
        db.session.add(meeting)
        db.session.commit()

        session_data = {
            'speak_config': speak_config,
            'listen_config': listen_config_data,
            'speak_queue': asyncio.Queue(maxsize=500),
            'listen_queue': asyncio.Queue(maxsize=500),
            'stop_event': asyncio.Event(),
            'reload_event': asyncio.Event(),
            'loop': loop,
            'start_time': time.time(),
            'transcript': [],
            'meeting_id': meeting.id
        }

        with sessions_lock:
            sessions[sid] = session_data

        app.logger.info(f"Session {sid} started")
        socketio.start_background_task(target=session_manager_task, sid=sid, loop=loop, app=app, socketio=socketio)

    @socketio.on('stop_session')
    def handle_stop_session():
        sid = request.sid
        with sessions_lock:
            if sid in sessions:
                sessions[sid]['stop_event'].set()
        app.logger.info(f"Stop requested: {sid}")

    @socketio.on('audio_chunk_speak')
    def handle_audio_chunk_speak(chunk):
        sid = request.sid
        with sessions_lock:
            session = sessions.get(sid)
        if session:
            try:
                asyncio.run_coroutine_threadsafe(session['speak_queue'].put(chunk), session['loop'])
            except Exception as e:
                app.logger.warning(f"Queue Error (speak): {e}")

    @socketio.on('audio_chunk_listen')
    def handle_audio_chunk_listen(chunk):
        sid = request.sid
        with sessions_lock:
            session = sessions.get(sid)
        if session:
            try:
                asyncio.run_coroutine_threadsafe(session['listen_queue'].put(chunk), session['loop'])
            except Exception as e:
                app.logger.warning(f"Queue Error (listen): {e}")

    @socketio.on('ping_from_client')
    def handle_ping(data):
        emit('pong_from_server', data, to=request.sid)


def session_manager_task(sid, loop, app, socketio):
    asyncio.set_event_loop(loop)

    with sessions_lock:
        session_check = sessions.get(sid)
    if session_check and 'reload_event' not in session_check:
        session_check['reload_event'] = asyncio.Event()

    try:
        while True:
            with sessions_lock:
                session_data = sessions.get(sid)
            if not session_data:
                break

            if session_data['stop_event'].is_set():
                break

            session_data['reload_event'].clear()
            current_translator_stop_event = asyncio.Event()

            async def run_tasks():
                tasks = []
                speak_config = session_data.get('speak_config', {})
                listen_config = session_data.get('listen_config', {})

                transcript = session_data.get('transcript', [])

                if speak_config.get('mode') == 'translate':
                    lang_from, lang_to = speak_config.get('direction', 'zh-en').split('-')
                    tasks.append(doubao_translator(
                        socketio, sid, lang_from, lang_to,
                        session_data['speak_queue'], current_translator_stop_event,
                        'speak', 's2s', glossary=speak_config.get('glossary'),
                        speaker_id=speak_config.get('speaker_id', ''),
                        transcript_collector=transcript
                    ))

                if listen_config and listen_config.get('mode') == 'translate':
                    lang_from, lang_to = listen_config.get('direction', 'en-zh').split('-')
                    tasks.append(doubao_translator(
                        socketio, sid, lang_from, lang_to,
                        session_data['listen_queue'], current_translator_stop_event,
                        'listen', 's2s', glossary=listen_config.get('glossary'),
                        speaker_id=listen_config.get('speaker_id', ''),
                        transcript_collector=transcript
                    ))

                async def monitor_signals():
                    elapsed = 0.0
                    while not current_translator_stop_event.is_set():
                        if session_data['stop_event'].is_set():
                            current_translator_stop_event.set()
                            return
                        if session_data['reload_event'].is_set():
                            current_translator_stop_event.set()
                            return
                        await asyncio.sleep(0.1)
                        elapsed += 0.1
                        if elapsed >= RECONNECT_INTERVAL:
                            app.logger.info(f"Session {sid} 定时重连触发")
                            session_data['reload_event'].set()
                            current_translator_stop_event.set()
                            return

                tasks.append(monitor_signals())
                if tasks:
                    await asyncio.gather(*tasks)

            loop.run_until_complete(run_tasks())

            if session_data['reload_event'].is_set():
                for q_name in ['speak_queue', 'listen_queue']:
                    q = session_data[q_name]
                    while not q.empty():
                        try:
                            q.get_nowait()
                        except asyncio.QueueEmpty:
                            break
                app.logger.info(f"Session {sid} 定时重连中...")
                continue
            else:
                break

    except Exception as e:
        app.logger.error(f"Session Manager Error: {e}")

    finally:
        end_time = time.time()
        with sessions_lock:
            session_info = sessions.get(sid, {})
        start_time = session_info.get('start_time', end_time)
        duration = int(end_time - start_time)

        transcript = session_info.get('transcript', [])
        meeting_id = session_info.get('meeting_id')

        with app.app_context():
            # 保存会议记录
            if meeting_id:
                try:
                    meetings_dir = os.path.join(app.root_path, '..', 'meetings')
                    os.makedirs(meetings_dir, exist_ok=True)
                    transcript_path_rel = None

                    if transcript:
                        filename = f"meeting_{meeting_id}_{int(end_time)}.json"
                        filepath = os.path.join(meetings_dir, filename)
                        transcript_data = {
                            'meeting_id': meeting_id,
                            'speak_direction': session_info.get('speak_config', {}).get('direction', ''),
                            'listen_direction': (session_info.get('listen_config') or {}).get('direction', ''),
                            'entries': transcript
                        }
                        with open(filepath, 'w', encoding='utf-8') as f:
                            json.dump(transcript_data, f, ensure_ascii=False, indent=2)
                        transcript_path_rel = f"meetings/{filename}"
                        app.logger.info(f"Meeting {meeting_id} transcript saved: {filename} ({len(transcript)} entries)")

                    meeting = db.session.get(Meeting, meeting_id)
                    if meeting:
                        meeting.end_time = datetime.now(timezone.utc)
                        meeting.duration_seconds = duration
                        meeting.transcript_path = transcript_path_rel
                        meeting.status = 'completed'
                        db.session.commit()
                except Exception as e:
                    app.logger.error(f"Failed to save meeting {meeting_id}: {e}")

        with sessions_lock:
            if sid in sessions:
                del sessions[sid]

        try:
            loop.close()
        except Exception:
            pass

        socketio.emit('session_stopped', to=sid)
        app.logger.info(f"Session {sid} stopped completely")
