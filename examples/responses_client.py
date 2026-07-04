import openai

# This example demonstrates how a client sends requests to the local proxy.
# The proxy listens on http://localhost:1234 by default, then forwards to the real upstream service.
client = openai.OpenAI(
    base_url="http://localhost:1234/v1",
    api_key="sk-no-key-required",
)

# Responses API example request. Start the proxy first:
#   python -m llm_proxy --target-url http://your-upstream-url/v1
response = client.responses.create(
    model="gpt-4.1",
    instructions="You are an AI assistant. Help users with their requests.",
    input="Write a limerick about python exceptions",
)

# Print the model's final output text; full request and response will be written to logs/ by the proxy.
print(response.output_text)
