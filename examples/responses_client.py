import openai


client = openai.OpenAI(
    base_url="http://localhost:1234/v1",
    api_key="sk-no-key-required",
)

response = client.responses.create(
    model="gpt-4.1",
    instructions="You are an AI assistant. Help users with their requests.",
    input="Write a limerick about python exceptions",
)

print(response.output_text)
