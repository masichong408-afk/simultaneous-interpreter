import os
import json
from flask import Blueprint, render_template, jsonify, request, send_file, abort, current_app
from app.extensions import db
from app.models import Meeting
import io

meetings_bp = Blueprint('meetings', __name__)


@meetings_bp.route('/meetings')
def meetings_page():
    return render_template('meetings.html')


@meetings_bp.route('/api/meetings')
def api_list_meetings():
    meetings = Meeting.query.order_by(Meeting.start_time.desc()).limit(50).all()
    result = []
    for m in meetings:
        result.append({
            'id': m.id,
            'title': m.title,
            'status': m.status,
            'start_time': m.start_time.isoformat() if m.start_time else None,
            'end_time': m.end_time.isoformat() if m.end_time else None,
            'duration_seconds': m.duration_seconds or 0,
            'speak_direction': m.speak_direction or '',
            'listen_direction': m.listen_direction or '',
            'has_transcript': bool(m.transcript_path)
        })
    return jsonify(result)


@meetings_bp.route('/api/meetings/<int:meeting_id>')
def api_get_meeting(meeting_id):
    meeting = Meeting.query.get_or_404(meeting_id)
    meta = {
        'id': meeting.id,
        'title': meeting.title,
        'status': meeting.status,
        'start_time': meeting.start_time.isoformat() if meeting.start_time else None,
        'end_time': meeting.end_time.isoformat() if meeting.end_time else None,
        'duration_seconds': meeting.duration_seconds or 0,
        'speak_direction': meeting.speak_direction or '',
        'listen_direction': meeting.listen_direction or '',
    }

    entries = []
    if meeting.transcript_path:
        filepath = os.path.join(current_app.root_path, '..', meeting.transcript_path)
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
            entries = data.get('entries', [])
        except Exception:
            entries = []

    return jsonify({'meta': meta, 'entries': entries})


@meetings_bp.route('/api/meetings/<int:meeting_id>/export')
def api_export_meeting(meeting_id):
    meeting = Meeting.query.get_or_404(meeting_id)
    fmt = request.args.get('format', 'txt').lower()

    entries = []
    if meeting.transcript_path:
        filepath = os.path.join(current_app.root_path, '..', meeting.transcript_path)
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
            entries = data.get('entries', [])
        except Exception:
            pass

    safe_title = (meeting.title or f'meeting_{meeting_id}').replace(' ', '_').replace(':', '-')

    if fmt == 'txt':
        lines = [f"会议记录 - {meeting.title}", f"时间：{meeting.start_time}", "=" * 50, ""]
        for e in entries:
            channel_label = '【我方】' if e['channel'] == 'speak' else '【对方】'
            type_label = '原文' if e['type'] == 'original' else '译文'
            ts = e.get('timestamp', '')[:19].replace('T', ' ')
            lines.append(f"[{ts}] {channel_label} {type_label}：{e['text']}")
        content = '\n'.join(lines)
        return send_file(
            io.BytesIO(content.encode('utf-8-sig')),
            mimetype='text/plain; charset=utf-8',
            as_attachment=True,
            download_name=f'{safe_title}.txt'
        )

    elif fmt == 'md':
        lines = [f"# {meeting.title}", f"", f"**时间**：{meeting.start_time}", ""]
        speak_entries = [e for e in entries if e['channel'] == 'speak']
        listen_entries = [e for e in entries if e['channel'] == 'listen']

        if speak_entries:
            lines.append("## 我方发言")
            lines.append("")
            for e in speak_entries:
                ts = e.get('timestamp', '')[:19].replace('T', ' ')
                prefix = '> ' if e['type'] == 'translated' else ''
                lines.append(f"**[{ts}]** {prefix}{e['text']}")
            lines.append("")

        if listen_entries:
            lines.append("## 对方发言")
            lines.append("")
            for e in listen_entries:
                ts = e.get('timestamp', '')[:19].replace('T', ' ')
                prefix = '> ' if e['type'] == 'translated' else ''
                lines.append(f"**[{ts}]** {prefix}{e['text']}")
        content = '\n'.join(lines)
        return send_file(
            io.BytesIO(content.encode('utf-8')),
            mimetype='text/markdown',
            as_attachment=True,
            download_name=f'{safe_title}.md'
        )

    abort(400, '不支持的导出格式，支持 txt 和 md')


@meetings_bp.route('/api/meetings/<int:meeting_id>', methods=['DELETE'])
def api_delete_meeting(meeting_id):
    meeting = Meeting.query.get_or_404(meeting_id)

    if meeting.transcript_path:
        filepath = os.path.join(current_app.root_path, '..', meeting.transcript_path)
        try:
            if os.path.exists(filepath):
                os.remove(filepath)
        except Exception:
            pass

    db.session.delete(meeting)
    db.session.commit()
    return jsonify({'ok': True})
