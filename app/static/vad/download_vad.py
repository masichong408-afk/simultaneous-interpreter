import requests
import os

# 目标文件和大小预估
filename = "silero_vad.onnx"
min_size = 1000000  # 至少要有1MB

# 备选下载地址列表
urls = [
    "https://github.com/snakers4/silero-vad/raw/v4.0/files/silero_vad.onnx",
    "https://mirror.ghproxy.com/https://github.com/snakers4/silero-vad/raw/v4.0/files/silero_vad.onnx",
    "https://ghproxy.net/https://github.com/snakers4/silero-vad/raw/v4.0/files/silero_vad.onnx",
    "https://cdn.jsdelivr.net/gh/snakers4/silero-vad@v4.0/files/silero_vad.onnx" 
]

print("开始尝试下载 Silero VAD 模型...")

for url in urls:
    try:
        print(f"正在尝试地址: {url}")
        # 设置超时，伪装浏览器UA
        headers = {'User-Agent': 'Mozilla/5.0'}
        r = requests.get(url, stream=True, headers=headers, timeout=20, verify=False)

        if r.status_code == 200:
            with open(filename, 'wb') as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)

            # 检查文件大小
            file_size = os.path.getsize(filename)
            print(f"下载完成！文件大小: {file_size/1024/1024:.2f} MB")

            if file_size > min_size:
                print("✅ 成功！文件看起来是正确的。")
                break
            else:
                print("❌ 失败：文件太小了，可能是个错误页面。尝试下一个...")
        else:
            print(f"❌ 请求失败，状态码: {r.status_code}")

    except Exception as e:
        print(f"❌ 发生错误: {e}")

print("------------------------------")
print("请运行 ls -lh 命令检查结果。")
