import openai

client = openai.OpenAI(
  base_url="http://localhost:1234/v1",  # 本地代理地址
  api_key = "sk-no-key-required"  # ik_llama.cpp 默认无需密钥
)

response = client.responses.create(
  model="gpt-4.1",
  instructions="You are an AI assistant. Help users with their requests.",
  input="Write a limerick about python exceptions"
)

print(response.output_text)
