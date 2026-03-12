/**
 * translator.js - 开源版同声传译前端逻辑
 * 依赖：socket.io, my_vad.js
 */
(function() {
    'use strict';

    // --- 平台检测 ---
    (function detectPlatform() {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        document.body.classList.add(isMac ? 'platform-mac' : 'platform-win');
    })();

    const socket = io();
    let currentLatency = 0;
    const HIGH_LATENCY_THRESHOLD = 400;
    let isRunning = false;
    let activeStreams = [];
    let ttsConfig = { speak: true, listen: true };

    // PCM 流式播放（AudioWorklet 环形缓冲区，消除分段卡顿）
    const TTS_SAMPLE_RATE = 24000;

    const ctxSpeak = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TTS_SAMPLE_RATE });
    const ctxListen = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TTS_SAMPLE_RATE });
    let workletNodes = { speak: null, listen: null };
    let workletReady = { speak: false, listen: false };
    let pendingPcm = { speak: [], listen: [] };

    async function initWorklet(prefix) {
        try {
            const ctx = prefix === 'speak' ? ctxSpeak : ctxListen;
            await ctx.audioWorklet.addModule('/static/js/pcm-player-processor.js');
            const node = new AudioWorkletNode(ctx, 'pcm-player-processor');

            // 音频美化链：worklet → 低通 → 高切搁架 → 压缩器 → 输出
            const lpf = ctx.createBiquadFilter();
            lpf.type = 'lowpass';
            lpf.frequency.value = 8000;
            lpf.Q.value = 0.707;

            const shelf = ctx.createBiquadFilter();
            shelf.type = 'highshelf';
            shelf.frequency.value = 4000;
            shelf.gain.value = -4;

            const comp = ctx.createDynamicsCompressor();
            comp.threshold.value = -24;
            comp.knee.value = 12;
            comp.ratio.value = 4;
            comp.attack.value = 0.003;
            comp.release.value = 0.15;

            node.connect(lpf);
            lpf.connect(shelf);
            shelf.connect(comp);
            comp.connect(ctx.destination);
            node.port.onmessage = (e) => {
                if (e.data === 'playing') setOutputState(prefix, true);
                if (e.data === 'idle') setOutputState(prefix, false);
            };
            workletNodes[prefix] = node;
            workletReady[prefix] = true;
            for (const c of pendingPcm[prefix]) postPcm(prefix, c);
            pendingPcm[prefix] = [];
        } catch (e) { console.error(`[translator][${prefix}] Worklet加载失败:`, e); }
    }
    initWorklet('speak');
    initWorklet('listen');

    function postPcm(prefix, data) {
        const node = workletNodes[prefix];
        if (!node) return;
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        const view = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
        const copy = new Float32Array(view);
        node.port.postMessage(copy, [copy.buffer]);
    }

    function pushPcmChunk(prefix, chunk) {
        if (!chunk || chunk.byteLength < 4) return;
        if (!workletReady[prefix]) {
            pendingPcm[prefix].push(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk);
            return;
        }
        postPcm(prefix, chunk);
    }

    function clearPcmQueue(prefix) {
        if (workletNodes[prefix]) workletNodes[prefix].port.postMessage('clear');
        pendingPcm[prefix] = [];
    }

    function resetWorklets() {
        if (workletNodes.speak) workletNodes.speak.port.postMessage('reset');
        if (workletNodes.listen) workletNodes.listen.port.postMessage('reset');
    }

    // 自动唤醒 AudioContext
    setInterval(() => {
        if (isRunning) {
            if (ctxSpeak.state === 'suspended') ctxSpeak.resume();
            if (ctxListen.state === 'suspended') ctxListen.resume();
        }
    }, 1000);

    // 防误触保护
    window.onbeforeunload = function(e) {
        if (isRunning) { e.preventDefault(); e.returnValue = '会议正在进行中，确定要退出吗？'; }
    };

    let deviceIds = { mic: 'default', spk: 'default' };
    let virtualCables = { cableA_Input_Id: null, cableB_Output_Id: null };
    let modes = { speak: 'translate', listen: 'translate' };
    let lastSessionPayload = null; // 断线重连用：保存最近一次 start_session 的 payload
    let borderStates = {
        speak: { input: false, output: false, inputTimer: null, outputTimer: null },
        listen: { input: false, output: false, inputTimer: null, outputTimer: null }
    };
    let energyThreshold = 2.0;
    let isCalibrating = false;
    let calibrationMaxEnergy = 0;

    // --- 向导 ---
    window.resetGuide = function() { sessionStorage.removeItem('guideShown'); location.reload(); };

    window.nextGuide = function(step) {
        document.querySelectorAll('.spotlight-active').forEach(e => e.classList.remove('spotlight-active'));
        document.getElementById('guide-modal').style.display = 'none';
        if (step === 1) document.getElementById('card-lang').classList.add('spotlight-active');
        if (step === 2) document.getElementById('card-audio').classList.add('spotlight-active');
        if (step === 3) document.getElementById('card-glossary').classList.add('spotlight-active');
    };

    window.finishGuide = function() {
        document.querySelectorAll('.spotlight-active').forEach(e => e.classList.remove('spotlight-active'));
        document.getElementById('guide-mask').style.display = 'none';
    };

    // --- 状态更新 ---
    function updateStatus(state, text) {
        const color = state === 'error' ? 'var(--status-red)' : state === 'warn' ? 'var(--status-yellow)' : 'var(--status-green)';
        const dot = document.getElementById('dash-status-dot');
        const txt = document.getElementById('connectionStatus');
        const actDot = document.getElementById('act-status-dot');
        const actTxt = document.getElementById('act-status-text');
        if (dot) dot.style.background = color;
        if (txt) { txt.innerText = text; txt.style.color = state === 'connected' ? 'var(--status-green)' : state === 'warn' ? 'var(--status-yellow)' : '#666'; }
        if (actDot) actDot.style.background = color;
        if (actTxt) actTxt.innerText = state === 'error' ? '离线 / Offline' : state === 'warn' ? '重连 / Retry...' : '就绪 / Ready';
    }

    function updateLatencyUI(ms) {
        currentLatency = ms;
        const color = ms < 150 ? 'var(--status-green)' : ms > 300 ? 'var(--status-red)' : '#666';
        const el1 = document.getElementById('networkLatency');
        const el2 = document.getElementById('act-latency');
        if (el1) { el1.innerText = ms + ' ms'; el1.style.color = color; }
        if (el2) { el2.innerText = ms + ' ms'; el2.style.color = color; }
        checkStartButtonState();
    }

    function checkStartButtonState() {
        const btn = document.getElementById('startBtn');
        if (currentLatency > HIGH_LATENCY_THRESHOLD) {
            btn.disabled = true; btn.innerText = `延迟过高 / High Latency (${currentLatency}ms)`; btn.classList.add('high-latency');
        } else if (socket.connected) {
            btn.disabled = false; btn.innerText = '开始运行 / Start'; btn.classList.remove('high-latency');
        } else {
            btn.disabled = true; btn.innerText = '连接中... / Connecting...';
        }
    }

    // --- 术语库 ---
    async function loadGlossary() {
        try {
            const res = await fetch('/api/glossary/categories');
            const data = await res.json();
            const list = document.getElementById('glossary-list-area');
            if (!list) return;
            list.innerHTML = '';
            const privateCats = data.filter(c => !c.is_public);
            const publicCats = data.filter(c => c.is_public);
            const renderItem = (cat, type) => {
                const div = document.createElement('div'); div.className = 'glossary-item';
                div.innerHTML = `<input type="checkbox" value="${cat.id}"><span class="glossary-text">${cat.name}</span><span class="glossary-tag">${type}</span>`;
                div.onclick = (e) => { if (e.target.tagName !== 'INPUT') div.querySelector('input').click(); };
                list.appendChild(div);
            };
            privateCats.forEach(c => renderItem(c, '私有 Private'));
            if (privateCats.length > 0 && publicCats.length > 0) {
                const sep = document.createElement('div'); sep.className = 'glossary-sep'; sep.innerText = '公共推荐 / Public'; list.appendChild(sep);
            }
            publicCats.forEach(c => renderItem(c, '通用 Public'));
            if (data.length === 0) list.innerHTML = '<div style="text-align:center;padding:10px;color:#666;font-size:12px;">暂无术语库 / No Glossary</div>';
        } catch (e) { console.error('Glossary Error', e); }
    }

    // --- 校准 ---
    window.calibrateNoise = async function() {
        const micId = document.getElementById('dev-real-mic').value;
        if (!micId || micId.includes('扫描中')) { alert('请先等待麦克风列表加载完毕 / Please wait for mic list'); return; }
        if (isCalibrating) return;
        isCalibrating = true; calibrationMaxEnergy = 0;
        const btn = document.getElementById('btn-calib');
        const originalHTML = '<span>⚡ 智能校准 / Auto Calibrate</span>';
        btn.classList.add('calibrating');
        let tempStream = null, tempCtx = null;
        try {
            tempStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micId }, autoGainControl: false, echoCancellation: false, noiseSuppression: false } });
            tempCtx = new (window.AudioContext || window.webkitAudioContext)();
            const src = tempCtx.createMediaStreamSource(tempStream);
            const analyser = tempCtx.createAnalyser(); analyser.fftSize = 2048;
            src.connect(analyser);
            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            const startTime = Date.now();
            function measure() {
                if (!isCalibrating) return;
                analyser.getByteTimeDomainData(dataArray);
                let sum = 0; for (let i = 0; i < bufferLength; i++) sum += Math.abs(dataArray[i] - 128);
                if (sum / bufferLength > calibrationMaxEnergy) calibrationMaxEnergy = sum / bufferLength;
                if (Date.now() - startTime < 3000) requestAnimationFrame(measure);
            }
            measure();
            for (let i = 3; i > 0; i--) {
                btn.innerHTML = `<span>🔊 保持安静... ${i}s / Keep Silent...</span>`;
                await new Promise(r => setTimeout(r, 1000));
            }
            let newThresh = calibrationMaxEnergy * 1.5;
            if (newThresh < 2.0) newThresh = 2.0;
            energyThreshold = newThresh;
            btn.innerHTML = `<span>✅ 校准完成 (阈值:${newThresh.toFixed(1)})</span>`;
        } catch (e) {
            console.error('校准失败', e); btn.innerHTML = '<span>❌ 错误 / Error</span>'; alert('校准失败: ' + e.message);
        } finally {
            if (tempStream) tempStream.getTracks().forEach(t => t.stop());
            if (tempCtx) tempCtx.close();
            isCalibrating = false; btn.classList.remove('calibrating');
            setTimeout(() => { btn.innerHTML = originalHTML; }, 3000);
        }
    };

    // --- 设备初始化 ---
    function isVirtualCable(l) { return /cable|vb[- ]?audio/i.test(l); }
    function is16ch(l) { return l.toLowerCase().includes('16ch'); }
    function isCableA(l) { return isVirtualCable(l) && /\ba\b|[-_ ]a\b/i.test(l); }
    function isCableB(l) { return isVirtualCable(l) && /\bb\b|[-_ ]b\b/i.test(l); }

    function fillSelect(id, list) {
        const sel = document.getElementById(id); if (!sel) return;
        sel.innerHTML = '';
        list.forEach(d => { const opt = document.createElement('option'); opt.value = d.deviceId; opt.text = d.label || `Device ${d.deviceId.substr(0, 4)}`; sel.appendChild(opt); });
    }

    async function initDevices() {
        try {
            if (typeof initVAD === 'function') await initVAD();
            const devs = await navigator.mediaDevices.enumerateDevices();
            const realMics = devs.filter(d => d.kind === 'audioinput' && !isVirtualCable(d.label));
            const realSpks = devs.filter(d => d.kind === 'audiooutput' && !isVirtualCable(d.label));
            fillSelect('dev-real-mic', realMics);
            fillSelect('dev-real-spk', realSpks);
            let cabA = devs.find(d => d.kind === 'audiooutput' && isCableA(d.label) && !is16ch(d.label)) || devs.find(d => d.kind === 'audiooutput' && isCableA(d.label));
            let cabB = devs.find(d => d.kind === 'audioinput' && isCableB(d.label) && !is16ch(d.label)) || devs.find(d => d.kind === 'audioinput' && isCableB(d.label));
            const statusA = document.getElementById('status-cable-a');
            const statusB = document.getElementById('status-cable-b');
            if (cabA) { virtualCables.cableA_Input_Id = cabA.deviceId; statusA.innerText = cabA.label; statusA.className = is16ch(cabA.label) ? 'isb-val warn' : 'isb-val ok'; }
            else { statusA.innerText = '未检测到 / Not Found'; statusA.className = 'isb-val err'; }
            if (cabB) { virtualCables.cableB_Output_Id = cabB.deviceId; statusB.innerText = cabB.label; statusB.className = is16ch(cabB.label) ? 'isb-val warn' : 'isb-val ok'; }
            else { statusB.innerText = '未检测到 / Not Found'; statusB.className = 'isb-val err'; }
        } catch (e) { console.error(e); }
    }

    // --- 会话控制 ---
    window.startSession = async function() {
        try {
            deviceIds.mic = document.getElementById('dev-real-mic').value;
            deviceIds.spk = document.getElementById('dev-real-spk').value;

            const hasCableA = !!virtualCables.cableA_Input_Id;
            const hasCableB = !!virtualCables.cableB_Output_Id;

            const langMySpeak = document.getElementById('lang-my-speak').value;
            const langTheirHear = document.getElementById('lang-their-hear').value;
            const langTheirSpeak = document.getElementById('lang-their-speak').value;
            const langMyHear = document.getElementById('lang-my-hear').value;

            modes.speak = langMySpeak === langTheirHear ? 'passthrough' : 'translate';
            modes.listen = langTheirSpeak === langMyHear ? 'passthrough' : 'translate';
            ttsConfig.speak = langMySpeak !== langTheirHear;
            ttsConfig.listen = langTheirSpeak !== langMyHear;

            // 语言方向校验
            const zhEn = ['zh', 'en'];
            if (langMySpeak === 'zhen' || langTheirHear === 'zhen') {
                if (langMySpeak !== 'zhen' || langTheirHear !== 'zhen') {
                    throw new Error('中英混说模式：源和目标都必须选"中英混说" / Mixed mode requires both set to Mixed');
                }
            } else if (!zhEn.includes(langMySpeak) && !zhEn.includes(langTheirHear)) {
                throw new Error('源语言或目标语言至少有一个须为中文或英文 / One side must be Chinese or English');
            }
            if (langTheirSpeak !== langMyHear && hasCableB) {
                if (langTheirSpeak === 'zhen' || langMyHear === 'zhen') {
                    if (langTheirSpeak !== 'zhen' || langMyHear !== 'zhen') {
                        throw new Error('中英混说模式：源和目标都必须选"中英混说" / Mixed mode requires both set to Mixed');
                    }
                } else if (!zhEn.includes(langTheirSpeak) && !zhEn.includes(langMyHear)) {
                    throw new Error('源语言或目标语言至少有一个须为中文或英文 / One side must be Chinese or English');
                }
            }

            const apiDirSpeak = `${langMySpeak}-${langTheirHear}`;
            const apiDirListen = `${langTheirSpeak}-${langMyHear}`;

            if (ctxSpeak.state === 'suspended') await ctxSpeak.resume();
            if (ctxListen.state === 'suspended') await ctxListen.resume();

            document.getElementById('section-dashboard').style.display = 'none';
            document.getElementById('section-action').style.display = 'flex';
            document.getElementById('ab-listen').style.display = hasCableB ? 'flex' : 'none';
            document.getElementById('ab-speak').style.flex = '1';

            const pCableA = document.getElementById('player-for-cable-a');
            if (hasCableA) {
                if (pCableA.setSinkId) await pCableA.setSinkId(virtualCables.cableA_Input_Id);
                if (ctxSpeak.setSinkId) await ctxSpeak.setSinkId(virtualCables.cableA_Input_Id);
            } else {
                // 无 Cable A 时输出到耳机（单通道模式）
                if (ctxSpeak.setSinkId) await ctxSpeak.setSinkId(deviceIds.spk);
            }
            const pHeadset = document.getElementById('player-for-headset');
            if (pHeadset.setSinkId) await pHeadset.setSinkId(deviceIds.spk);
            if (ctxListen.setSinkId) await ctxListen.setSinkId(deviceIds.spk);

            // 启动 speak 流（VAD 过滤）
            await setupStream('speak', deviceIds.mic, ctxSpeak, pCableA, modes.speak);
            // 有 Cable B 时才启动 listen 流
            if (hasCableB) await setupStream('listen', virtualCables.cableB_Output_Id, ctxListen, pHeadset, modes.listen);

            const catIds = Array.from(document.querySelectorAll('.glossary-item input:checked')).map(c => parseInt(c.value));
            const voiceSpeak = document.getElementById('voice-speak');
            const voiceListen = document.getElementById('voice-listen');
            const speakCfg = { mode: 'translate', direction: apiDirSpeak, deviceId: deviceIds.mic, category_ids: catIds, speaker_id: voiceSpeak ? voiceSpeak.value : '' };
            const listenCfg = hasCableB ? { mode: 'translate', direction: apiDirListen, deviceId: virtualCables.cableB_Output_Id, category_ids: [], speaker_id: voiceListen ? voiceListen.value : '' } : null;
            lastSessionPayload = { speak_config: speakCfg, listen_config: listenCfg };
            socket.emit('start_session', lastSessionPayload);
            isRunning = true;
        } catch (e) { console.error(e); alert('启动失败 / Start Failed: ' + e.message); stopSession(); }
    };

    window.stopSession = function() {
        try { if (socket) socket.emit('stop_session'); } catch (e) {}
        isRunning = false;
        lastSessionPayload = null;
        clearPcmQueue('speak');
        clearPcmQueue('listen');
        resetWorklets();
        activeStreams.forEach(s => {
            if (s.stream) s.stream.getTracks().forEach(t => t.stop());
            if (s.analysisContext) s.analysisContext.close().catch(console.error);
        });
        activeStreams = [];
        borderStates = {
            speak: { input: false, output: false, inputTimer: null, outputTimer: null },
            listen: { input: false, output: false, inputTimer: null, outputTimer: null }
        };
        refreshBorderUI('speak'); refreshBorderUI('listen');
        ['speak', 'listen'].forEach(p => {
            const pT = document.getElementById(`pending-trans-${p}`);
            const pO = document.getElementById(`pending-orig-${p}`);
            const paneT = document.getElementById(`pane-trans-${p}`);
            const paneO = document.getElementById(`pane-orig-${p}`);
            if (paneT && pT) { paneT.innerHTML = ''; paneT.appendChild(pT); pT.innerText = '...'; }
            if (paneO && pO) { paneO.innerHTML = ''; paneO.appendChild(pO); pO.innerText = 'Ready'; }
        });
        document.getElementById('section-action').style.display = 'none';
        document.getElementById('section-dashboard').style.display = 'flex';
        const al = document.getElementById('ab-listen');
        if (al) al.style.display = 'flex';
    };

    // --- 音频流 + VAD 接入 SocketHandler ---
    async function setupStream(prefix, deviceId, playbackContext, playerEl, mode) {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: deviceId }, sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        const analysisContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        if (analysisContext.state === 'suspended') await analysisContext.resume();
        await analysisContext.audioWorklet.addModule('/static/js/audio-processor.js');
        const source = analysisContext.createMediaStreamSource(stream);
        const processor = new AudioWorkletNode(analysisContext, 'audio-processor');
        const analyser = analysisContext.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        analyser.connect(processor);
        // 静音节点防止输出到扬声器
        const muteNode = analysisContext.createGain();
        muteNode.gain.value = 0;
        source.connect(muteNode);
        muteNode.connect(analysisContext.destination);

        // speak 通道：VAD 过滤 — 静音时发送零帧保持流存活
        // listen 通道：远端音频，直接发送
        let _lastSpeechTime = 0;
        const VAD_THRESHOLD = 0.5;
        const VAD_HANGOVER_MS = 500;

        processor.port.onmessage = async (e) => {
            if (!isRunning) return;
            if (prefix === 'speak' && typeof detectSpeech === 'function') {
                const int16 = new Int16Array(e.data);
                const float32 = new Float32Array(int16.length);
                for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;
                try {
                    const prob = await detectSpeech(float32);
                    const now = Date.now();
                    if (prob > VAD_THRESHOLD) _lastSpeechTime = now;
                    if (now - _lastSpeechTime > VAD_HANGOVER_MS) {
                        const silenceFrame = new ArrayBuffer(int16.byteLength);
                        socket.emit(`audio_chunk_${prefix}`, silenceFrame);
                        return;
                    }
                } catch (err) {
                    // VAD 推理失败时降级发送原始音频
                }
            }
            socket.emit(`audio_chunk_${prefix}`, e.data);
        };

        monitorAudioLevel(prefix, analyser);
        activeStreams.push({ stream, analysisContext });

        if (mode === 'passthrough') {
            playerEl.srcObject = stream; playerEl.muted = false; playerEl.play().catch(console.error);
        } else {
            playerEl.srcObject = null;
        }
    }

    function monitorAudioLevel(prefix, analyser) {
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        const floatData = new Float32Array(analyser.fftSize);
        function loop() {
            if (!isRunning) return;
            requestAnimationFrame(loop);
            analyser.getByteTimeDomainData(dataArray);
            analyser.getFloatTimeDomainData(floatData);
            let sum = 0; for (let i = 0; i < bufferLength; i++) sum += Math.abs(dataArray[i] - 128);
            const avg = sum / bufferLength;
            if (isCalibrating) { if (avg > calibrationMaxEnergy) calibrationMaxEnergy = avg; return; }
            if (prefix === 'speak') {
                if (typeof detectSpeech === 'function') detectSpeech(floatData.slice(0, 512)).then(p => { if (p > 0.3) triggerInputState(prefix); }).catch(() => {});
                if (avg > energyThreshold) triggerInputState(prefix);
            } else {
                if (avg > energyThreshold) triggerInputState(prefix);
            }
        }
        loop();
    }

    function triggerInputState(prefix) {
        const st = borderStates[prefix];
        if (!st.input) { st.input = true; refreshBorderUI(prefix); }
        if (st.inputTimer) clearTimeout(st.inputTimer);
        st.inputTimer = setTimeout(() => { st.input = false; st.inputTimer = null; refreshBorderUI(prefix); }, 1200);
    }

    function setOutputState(prefix, isActive) {
        const st = borderStates[prefix];
        if (isActive) {
            if (st.outputTimer) clearTimeout(st.outputTimer);
            if (!st.output) { st.output = true; refreshBorderUI(prefix); }
        } else if (st.output && !st.outputTimer) {
            st.outputTimer = setTimeout(() => { st.output = false; st.outputTimer = null; refreshBorderUI(prefix); }, 500);
        }
    }

    function refreshBorderUI(prefix) {
        const st = borderStates[prefix];
        const box = document.getElementById(prefix === 'speak' ? 'ab-speak' : 'ab-listen');
        if (!box) return;
        const tag = box.querySelector('.ab-tag');
        box.classList.remove('active-green', 'active-yellow');
        if (st.input || st.output) {
            box.classList.add('active-green'); if (tag) tag.style.opacity = 1;
            if (tag) tag.innerText = st.input ? (st.output ? '同步中 / SYNCING' : '正在听 / LISTENING') : '正在读 / PLAYING';
        } else { if (tag) tag.style.opacity = 0; }
    }

    // scheduleBuffer 已被 AudioWorklet 替代

    // --- 字幕更新 ---
    function updateText(prefix, data) {
        const pendingTrans = document.getElementById(`pending-trans-${prefix}`);
        const pendingOrig = document.getElementById(`pending-orig-${prefix}`);
        const paneTrans = document.getElementById(`pane-trans-${prefix}`);
        const paneOrig = document.getElementById(`pane-orig-${prefix}`);
        const isTranslated = data.type === 'translated';
        const isOriginal = data.type === 'original';
        let targetPane, targetPending;
        if (prefix === 'speak') {
            // speak面板：原文(我说的)→下方，译文(对方听的)→上方
            targetPane = isTranslated ? paneTrans : paneOrig;
            targetPending = isTranslated ? pendingTrans : pendingOrig;
        } else {
            // listen面板：原文(对方说的)→上方，译文(我听的)→下方
            targetPane = isTranslated ? paneOrig : paneTrans;
            targetPending = isTranslated ? pendingOrig : pendingTrans;
        }
        if (data.isFinal) {
            if (data.text && targetPane) {
                const span = document.createElement('span'); span.className = 'sentence-final';
                span.innerText = data.text + ' '; targetPane.insertBefore(span, targetPending);
                if (targetPending) targetPending.innerText = targetPane === paneOrig ? 'Ready' : '';
                const finalSentences = targetPane.querySelectorAll('.sentence-final');
                const MAX_VISIBLE = 100;
                if (finalSentences.length > MAX_VISIBLE) {
                    for (let i = 0; i < finalSentences.length - MAX_VISIBLE; i++) finalSentences[i].remove();
                }
            }
        } else if (targetPending) { targetPending.innerText = data.text || '...'; }
        if (paneTrans) requestAnimationFrame(() => { paneTrans.scrollTop = paneTrans.scrollHeight; });
        if (paneOrig) requestAnimationFrame(() => { paneOrig.scrollTop = paneOrig.scrollHeight; });
    }

    // --- SocketIO 事件绑定 ---
    function bindSocketEvents() {
        socket.on('translation_service_status', (data) => {
            updateStatus(data.status === 'connected' ? 'connected' : data.status === 'reconnecting' ? 'warn' : 'error', data.message);
        });
        socket.on('connect', () => {
            if (isRunning && lastSessionPayload) {

                updateStatus('warn', '连接恢复，重启会话... / Reconnecting...');
                clearPcmQueue('speak');
                clearPcmQueue('listen');
                socket.emit('start_session', lastSessionPayload);
            } else {
                updateStatus('connected', '服务已连接 / Service Connected');
            }
            checkStartButtonState();
        });
        socket.on('disconnect', () => {
            updateStatus('error', '连接断开，自动重连中... / Reconnecting...');
        });
        socket.on('pong_from_server', d => updateLatencyUI(Date.now() - d.t));
        socket.on('session_stopped', () => { if (isRunning) stopSession(); });

        // PCM流式播放：每个chunk推入累积区，达到阈值自动刷新播放
        socket.on('audio_data_speak', c => { if (ttsConfig.speak) pushPcmChunk('speak', c); });
        socket.on('audio_data_listen', c => { if (ttsConfig.listen) pushPcmChunk('listen', c); });
        // AudioWorklet 直接播放，tts_sentence_end 无需额外处理
        socket.on('tts_sentence_end_speak', () => {});
        socket.on('tts_sentence_end_listen', () => {});
        socket.on('text_update_speak', d => updateText('speak', d));
        socket.on('text_update_listen', d => updateText('listen', d));

        setInterval(() => { if (socket.connected) socket.emit('ping_from_client', { t: Date.now() }); }, 2000);
        if (socket.connected) updateStatus('connected', '服务已连接 / Service Connected');
    }

    // --- 语言联动：根据源语言禁用不合法的目标选项 ---
    // 允许源=目标（直通模式：不翻译语音，仅显示字幕）
    function syncLangOptions(srcId, tgtId) {
        const srcVal = document.getElementById(srcId).value;
        const tgt = document.getElementById(tgtId);
        const zhEn = ['zh', 'en'];

        Array.from(tgt.options).forEach(opt => {
            if (srcVal === 'zhen') {
                opt.disabled = opt.value !== 'zhen';
            } else if (zhEn.includes(srcVal)) {
                // 允许选自身（直通），禁止选 zhen
                opt.disabled = opt.value === 'zhen';
            } else {
                // 小语种：目标只能选中文或英文，或选自身（直通）
                opt.disabled = !zhEn.includes(opt.value) && opt.value !== srcVal;
            }
        });

        if (tgt.options[tgt.selectedIndex].disabled) {
            const first = Array.from(tgt.options).find(o => !o.disabled);
            if (first) tgt.value = first.value;
        }
    }

    function initLangSync() {
        const pairs = [
            ['lang-my-speak', 'lang-their-hear'],
            ['lang-their-speak', 'lang-my-hear']
        ];
        pairs.forEach(([srcId, tgtId]) => {
            document.getElementById(srcId).addEventListener('change', () => syncLangOptions(srcId, tgtId));
            syncLangOptions(srcId, tgtId);
        });
    }

    // --- DOMContentLoaded ---
    document.addEventListener('DOMContentLoaded', async () => {
        initLangSync();
        try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { alert('请允许麦克风权限 / Please Allow Mic Permission'); }
        await initDevices();
        loadGlossary();
        bindSocketEvents();

        if (!sessionStorage.getItem('guideShown')) {
            document.getElementById('guide-mask').style.display = 'block';
            document.getElementById('guide-modal').style.display = 'flex';
            sessionStorage.setItem('guideShown', 'true');
        } else {
            document.querySelectorAll('.spotlight-active').forEach(e => e.classList.remove('spotlight-active'));
        }
    });

})();
