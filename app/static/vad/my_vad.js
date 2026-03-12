// 1. 配置路径：告诉浏览器去哪里找那几个 .wasm 文件
ort.env.wasm.wasmPaths = {
    'ort-wasm.wasm': '/static/vad/ort-wasm.wasm',
    'ort-wasm-simd.wasm': '/static/vad/ort-wasm-simd.wasm'
};

let vadSession = null;
let vadState = { h: null, c: null, sr: null };

// 2. 初始化 VAD 模型 (加载大脑)
async function initVAD() {
    try {
        console.log("正在加载 Silero VAD 模型...");
        vadSession = await ort.InferenceSession.create('/static/vad/silero_vad.onnx');

        // 初始化内部状态 (h和c张量，全为0)
        const zeros = new Float32Array(2 * 1 * 64).fill(0);
        vadState.h = new ort.Tensor('float32', zeros, [2, 1, 64]);
        vadState.c = new ort.Tensor('float32', zeros, [2, 1, 64]);
        // 设置采样率 16000
        vadState.sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), [1]);

        console.log("✅ VAD 模型加载成功！智能听觉已就绪。");
    } catch (e) {
        console.error("❌ VAD 加载失败:", e);
    }
}

// 3. 检测是否在说话 (核心函数)
// 输入：audioData (Float32Array 格式的音频片段)
// 输出：概率值 (0~1，越大表示越像人声)
async function detectSpeech(audioData) {
    if (!vadSession) return 0; // 没加载好就当没听见

    try {
        // 构造输入张量 [1, N]
        const input = new ort.Tensor('float32', audioData, [1, audioData.length]);

        // 运行推理
        const feeds = { input: input, sr: vadState.sr, h: vadState.h, c: vadState.c };
        const results = await vadSession.run(feeds);

        // 更新状态 (为了下一句能连贯)
        vadState.h = results.hn;
        vadState.c = results.cn;

        // 返回结果 (output 张量中的第一个值)
        return results.output.data[0];
    } catch (e) {
        // 偶尔出错不用慌，返回0即可
        return 0;
    }
}
