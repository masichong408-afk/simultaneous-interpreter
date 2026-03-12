// /var/www/translator/app/static/js/audio-processor.js

class AudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // 1280 采样 @ 16kHz = 80ms/包，符合API文档建议（原4096=256ms有170ms额外延迟）
        this.bufferSize = 1280;
        this.buffer = new Float32Array(this.bufferSize);
        this.pos = 0;
    }

    /**
     * 将 Float32 采样点转换为 16-bit PCM 格式
     */
    floatTo16BitPCM(input) {
        const output = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
            // 限制振幅范围在 -1 到 1 之间并转换
            const s = Math.max(-1, Math.min(1, input[i]));
            output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return output;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (input && input[0]) {
            const channelData = input[0];

            // 使用内存拷贝方式填充缓冲区，比 push(...data) 性能更高
            for (let i = 0; i < channelData.length; i++) {
                this.buffer[this.pos++] = channelData[i];

                if (this.pos >= this.bufferSize) {
                    const pcmData = this.floatTo16BitPCM(this.buffer);
                    
                    // 使用 Transferable Objects 零拷贝传输二进制数据
                    this.port.postMessage(pcmData.buffer, [pcmData.buffer]);
                    this.pos = 0; // 重置计数器
                }
            }
        }
        return true;
    }
}

registerProcessor('audio-processor', AudioProcessor);
