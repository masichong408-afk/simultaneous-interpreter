import os
import sys
import uuid
import logging
import asyncio
import websockets
from datetime import datetime, timezone
from websockets.exceptions import ConnectionClosed, InvalidStatus, InvalidURI
from app.config import Config

# Protobuf 路径：从 app/services/ 向上两级到项目根目录
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
protogen_dir = os.path.join(project_root, "python_protogen")
if protogen_dir not in sys.path:
    sys.path.append(protogen_dir)

from products.understanding.ast.ast_service_pb2 import TranslateRequest, TranslateResponse
from common.events_pb2 import Type

WS_CONNECT_TIMEOUT = 30
WS_PING_INTERVAL = 20
WS_PING_TIMEOUT = 10
MAX_RETRY_ATTEMPTS = 3
RETRY_DELAY = 2

async def doubao_translator(socketio, sid, lang_from, lang_to, audio_queue, stop_event, event_prefix, mode, glossary=None, speaker_id=None, transcript_collector=None):
    if not Config.VOLCANO_APP_KEY or not Config.VOLCANO_ACCESS_KEY:
        error_msg = "火山引擎API密钥未配置"
        logging.error(f"[{event_prefix}][{sid}] {error_msg}")
        socketio.emit('translation_service_status',
                     {'status': 'error', 'message': error_msg, 'channel': event_prefix},
                     to=sid)
        return

    session_id = str(uuid.uuid4())
    conn_id = str(uuid.uuid4())
    ws_url = "wss://openspeech.bytedance.com/api/v4/ast/v2/translate"
    resource_id = "volc.service_type.10053"

    headers = {
        "X-Api-App-Key": Config.VOLCANO_APP_KEY,
        "X-Api-Access-Key": Config.VOLCANO_ACCESS_KEY,
        "X-Api-Resource-Id": resource_id,
        "X-Api-Connect-Id": conn_id
    }

    socketio.emit('translation_service_status',
                  {'status': 'connecting', 'message': '连接翻译服务...', 'channel': event_prefix},
                  to=sid)

    last_error = None
    for attempt in range(MAX_RETRY_ATTEMPTS):
        try:
            async with websockets.connect(
                ws_url,
                additional_headers=headers,
                ping_interval=WS_PING_INTERVAL,
                ping_timeout=WS_PING_TIMEOUT,
                close_timeout=10
            ) as ws:
                logging.info(f"[{event_prefix}][{sid}] 翻译WebSocket连接成功 (尝试 {attempt + 1}/{MAX_RETRY_ATTEMPTS})")

                request_payload = {'mode': mode, 'source_language': lang_from, 'target_language': lang_to}

                if speaker_id:
                    request_payload['speaker_id'] = speaker_id

                if glossary:
                    request_payload['corpus'] = {'glossary_list': glossary}

                start_req = TranslateRequest(
                    event=Type.StartSession,
                    request_meta={'SessionID': session_id},
                    user={'uid': "web_client"},
                    source_audio={'format': 'wav', 'codec': 'raw', 'rate': 16000, 'bits': 16, 'channel': 1},
                    # PCM原始格式（float32）：无编码延迟，前端可逐帧流式播放
                    target_audio={'format': 'pcm', 'rate': 24000},
                    request=request_payload)

                # 服务端降噪：让火山引擎对输入音频降噪，提升ASR识别准确度
                start_req.denoise = True

                try:
                    await asyncio.wait_for(ws.send(start_req.SerializeToString()), timeout=10)
                except asyncio.TimeoutError:
                    raise Exception("发送启动请求超时")

                try:
                    first_resp_msg = await asyncio.wait_for(ws.recv(), timeout=10)
                except asyncio.TimeoutError:
                    raise Exception("接收启动响应超时")

                first_resp = TranslateResponse()
                first_resp.ParseFromString(first_resp_msg)

                if first_resp.event != Type.SessionStarted:
                    error_code = getattr(first_resp.response_meta, 'Code', 'UNKNOWN')
                    error_message = getattr(first_resp.response_meta, 'Message', '会话启动失败')

                    if error_code in ['AUTH_FAILED', 'INVALID_KEY', 'UNAUTHORIZED']:
                        logging.error(f"[{event_prefix}][{sid}] 认证失败: {error_message} (错误码: {error_code})")
                        socketio.emit('translation_service_status',
                                     {'status': 'error', 'message': f'认证失败: {error_message}', 'channel': event_prefix},
                                     to=sid)
                        return

                    raise Exception(f"会话启动失败: {error_message} (错误码: {error_code})")

                logging.info(f"[{event_prefix}][{sid}] 会话成功启动")
                socketio.emit('translation_service_status',
                             {'status': 'connected', 'message': '翻译服务已连接', 'channel': event_prefix},
                             to=sid)

                async def sender():
                    try:
                        while not stop_event.is_set():
                            try:
                                chunk = await asyncio.wait_for(audio_queue.get(), timeout=1.0)
                                task_req = TranslateRequest(
                                    event=Type.TaskRequest,
                                    request_meta={'SessionID': session_id},
                                    source_audio={'binary_data': chunk}
                                )
                                await ws.send(task_req.SerializeToString())
                            except asyncio.TimeoutError:
                                continue
                            except ConnectionClosed:
                                logging.warning(f"[{event_prefix}][{sid}] WebSocket连接已关闭（发送端）")
                                break
                            except Exception as e:
                                logging.error(f"[{event_prefix}][{sid}] Sender Error: {e}")
                                break
                    finally:
                        try:
                            if not ws.closed:
                                finish_req = TranslateRequest(
                                    event=Type.FinishSession,
                                    request_meta={'SessionID': session_id}
                                )
                                await asyncio.wait_for(ws.send(finish_req.SerializeToString()), timeout=5)
                                logging.info(f"[{event_prefix}][{sid}] 已发送结束信号")
                        except (ConnectionClosed, asyncio.TimeoutError, Exception) as e:
                            logging.debug(f"[{event_prefix}][{sid}] 发送结束信号失败（连接可能已断开）: {e}")

                async def receiver():
                    try:
                        while not stop_event.is_set():
                            try:
                                message = await asyncio.wait_for(ws.recv(), timeout=1.0)
                                response = TranslateResponse()
                                response.ParseFromString(message)
                                event_type = response.event

                                if event_type == Type.SessionFinished:
                                    logging.info(f"[{event_prefix}][{sid}] 会话正常结束")
                                    break
                                elif event_type == Type.SessionFailed:
                                    error_msg = getattr(response.response_meta, 'Message', '会话失败')
                                    error_code = getattr(response.response_meta, 'Code', 'UNKNOWN')
                                    logging.error(f"[{event_prefix}][{sid}] 会话失败: {error_msg} (错误码: {error_code})")
                                    socketio.emit('translation_service_status',
                                                 {'status': 'error', 'message': f'会话失败: {error_msg}', 'channel': event_prefix},
                                                 to=sid)
                                    break
                                elif event_type == Type.SourceSubtitleResponse:
                                    socketio.emit(f'text_update_{event_prefix}',
                                                 {'type': 'original', 'text': response.text, 'isFinal': False},
                                                 to=sid)
                                elif event_type == Type.SourceSubtitleEnd:
                                    socketio.emit(f'text_update_{event_prefix}',
                                                 {'type': 'original', 'text': response.text, 'isFinal': True},
                                                 to=sid)
                                    if transcript_collector is not None and response.text:
                                        transcript_collector.append({
                                            'channel': event_prefix,
                                            'type': 'original',
                                            'text': response.text,
                                            'timestamp': datetime.now(timezone.utc).isoformat()
                                        })
                                elif event_type == Type.TranslationSubtitleResponse:
                                    socketio.emit(f'text_update_{event_prefix}',
                                                 {'type': 'translated', 'text': response.text, 'isFinal': False},
                                                 to=sid)
                                elif event_type == Type.TranslationSubtitleEnd:
                                    socketio.emit(f'text_update_{event_prefix}',
                                                 {'type': 'translated', 'text': response.text, 'isFinal': True},
                                                 to=sid)
                                    if transcript_collector is not None and response.text:
                                        transcript_collector.append({
                                            'channel': event_prefix,
                                            'type': 'translated',
                                            'text': response.text,
                                            'timestamp': datetime.now(timezone.utc).isoformat()
                                        })
                                elif event_type == Type.TTSResponse and response.data:
                                    socketio.emit(f'audio_data_{event_prefix}', response.data, to=sid)
                                elif event_type == Type.TTSSentenceEnd:
                                    socketio.emit(f'tts_sentence_end_{event_prefix}', to=sid)
                                elif event_type == Type.UsageResponse:
                                    # 计量事件：记录实际音频时长和token消耗
                                    billing = response.response_meta.billing if hasattr(response.response_meta, 'billing') else None
                                    if billing:
                                        duration_ms = getattr(billing, 'duration_msec', 0)
                                        socketio.emit(f'usage_update_{event_prefix}',
                                                     {'duration_ms': duration_ms},
                                                     to=sid)
                                        logging.info(f"[{event_prefix}][{sid}] 计量: {duration_ms}ms")
                                elif event_type == Type.AudioMuted:
                                    # 静音检测事件：通知前端显示"检测到静音"提示
                                    muted_ms = getattr(response, 'muted_duration_ms', 0)
                                    socketio.emit(f'audio_muted_{event_prefix}',
                                                 {'muted_ms': muted_ms},
                                                 to=sid)

                            except asyncio.TimeoutError:
                                continue
                            except ConnectionClosed:
                                logging.warning(f"[{event_prefix}][{sid}] WebSocket连接已关闭（接收端）")
                                break
                            except Exception as e:
                                logging.error(f"[{event_prefix}][{sid}] Receiver Error: {e}")
                                break
                    except Exception as e:
                        logging.error(f"[{event_prefix}][{sid}] Receiver outer error: {e}")

                await asyncio.gather(sender(), receiver(), return_exceptions=True)
                break

        except (ConnectionClosed, InvalidStatus, InvalidURI) as e:
            last_error = f"WebSocket连接错误: {str(e)}"
            logging.warning(f"[{event_prefix}][{sid}] {last_error} (尝试 {attempt + 1}/{MAX_RETRY_ATTEMPTS})")

            if attempt < MAX_RETRY_ATTEMPTS - 1:
                socketio.emit('translation_service_status',
                             {'status': 'connecting', 'message': f'连接失败，正在重试 ({attempt + 1}/{MAX_RETRY_ATTEMPTS})...', 'channel': event_prefix},
                             to=sid)
                await asyncio.sleep(RETRY_DELAY * (attempt + 1))
            else:
                socketio.emit('translation_service_status',
                             {'status': 'error', 'message': f'连接失败，已重试{MAX_RETRY_ATTEMPTS}次', 'channel': event_prefix},
                             to=sid)

        except asyncio.TimeoutError:
            last_error = "连接超时"
            logging.warning(f"[{event_prefix}][{sid}] {last_error} (尝试 {attempt + 1}/{MAX_RETRY_ATTEMPTS})")

            if attempt < MAX_RETRY_ATTEMPTS - 1:
                socketio.emit('translation_service_status',
                             {'status': 'connecting', 'message': f'连接超时，正在重试 ({attempt + 1}/{MAX_RETRY_ATTEMPTS})...', 'channel': event_prefix},
                             to=sid)
                await asyncio.sleep(RETRY_DELAY * (attempt + 1))
            else:
                socketio.emit('translation_service_status',
                             {'status': 'error', 'message': '连接超时，请检查网络连接', 'channel': event_prefix},
                             to=sid)

        except Exception as e:
            last_error = f"翻译服务异常: {str(e)}"
            error_type = type(e).__name__
            logging.error(f"[{event_prefix}][{sid}] {last_error} (类型: {error_type})")

            if error_type in ['ConnectionError', 'OSError', 'TimeoutError'] and attempt < MAX_RETRY_ATTEMPTS - 1:
                socketio.emit('translation_service_status',
                             {'status': 'connecting', 'message': f'连接异常，正在重试 ({attempt + 1}/{MAX_RETRY_ATTEMPTS})...', 'channel': event_prefix},
                             to=sid)
                await asyncio.sleep(RETRY_DELAY * (attempt + 1))
            else:
                socketio.emit('translation_service_status',
                             {'status': 'error', 'message': f'连接AI服务失败: {str(e)}', 'channel': event_prefix},
                             to=sid)
                break

    if last_error and attempt == MAX_RETRY_ATTEMPTS - 1:
        logging.error(f"[{event_prefix}][{sid}] 翻译服务连接失败，已重试{MAX_RETRY_ATTEMPTS}次。最后错误: {last_error}")

    logging.info(f"[{event_prefix}][{sid}] 翻译任务结束")
    stop_event.set()
