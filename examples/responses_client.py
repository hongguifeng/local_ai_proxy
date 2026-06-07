import openai


# 这个示例演示客户端如何把请求发到本地代理。
# 代理默认监听 http://localhost:1234，再由代理转发到真实上游服务。
client = openai.OpenAI(
    base_url="http://localhost:1234/v1",
    api_key="sk-no-key-required",
)

# Responses API 示例请求。运行前需要先启动代理：
#   python -m llm_proxy --target-url http://你的上游地址/v1
response = client.responses.create(
    model="gpt-4.1",
    instructions="You are an AI assistant. Help users with their requests.",
    input="Write a limerick about python exceptions",
)

# 打印模型最终输出文本；完整请求和响应会被代理写入 logs/。
print(response.output_text)
