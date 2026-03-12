/**
 * pcm-player-processor.js - PCM 流式播放 AudioWorklet
 *
 * 环形缓冲区持续输出音频，消除分段拼接卡顿。
 * 通过 postMessage 接收 Float32Array 写入，缓冲区空时输出静音。
 *
 * 启播缓冲：首句立即播放，后续句子积累一定数据量后再开始，
 * 避免短句"突然蹦出"的急促感。
 */
class PCMPlayerProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._size = 24000 * 10; // 10秒环形缓冲区
        this._buf = new Float32Array(this._size);
        this._w = 0;
        this._r = 0;
        this._playing = false;
        this._firstBurst = true; // 首句标记：首次播放跳过缓冲门槛
        this._startThreshold = 24000 * 0.4; // 400ms @ 24kHz，后续句子的启播门槛

        this.port.onmessage = (e) => {
            if (e.data === 'clear') {
                this._r = this._w;
                if (this._playing) {
                    this._playing = false;
                    this.port.postMessage('idle');
                }
                return;
            }
            if (e.data === 'reset') {
                // 新会话开始时重置，确保首句立即播放
                this._firstBurst = true;
                return;
            }
            const samples = e.data;
            const avail = this._w - this._r;
            const n = Math.min(samples.length, this._size - avail);
            for (let i = 0; i < n; i++) {
                this._buf[(this._w + i) % this._size] = samples[i];
            }
            this._w += n;
        };
    }

    process(inputs, outputs) {
        const out = outputs[0][0];
        const avail = this._w - this._r;

        if (avail <= 0) {
            out.fill(0);
            if (this._playing) {
                this._playing = false;
                this.port.postMessage('idle');
            }
            return true;
        }

        // 启播缓冲判断：非首句时，等缓冲区积累到门槛再开始播放
        if (!this._playing) {
            if (this._firstBurst) {
                // 首句：立即播放，并清除首句标记
                this._firstBurst = false;
            } else if (avail < this._startThreshold) {
                // 后续句子：数据不足门槛，继续输出静音等待积累
                out.fill(0);
                return true;
            }
            this._playing = true;
            this.port.postMessage('playing');
        }

        const n = Math.min(out.length, avail);
        for (let i = 0; i < n; i++) {
            out[i] = this._buf[(this._r + i) % this._size];
        }
        this._r += n;
        for (let i = n; i < out.length; i++) {
            out[i] = 0;
        }
        return true;
    }
}

registerProcessor('pcm-player-processor', PCMPlayerProcessor);
