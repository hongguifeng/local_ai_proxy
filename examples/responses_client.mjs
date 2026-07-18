import OpenAI from "openai";

// Install the SDK in the directory where you run this example:
//   npm install openai
// Start LLM Proxy, configure the upstream target in the web console, and enable the proxy pair.
const client = new OpenAI({
  baseURL: "http://127.0.0.1:1234/v1",
  apiKey: "sk-no-key-required",
});

const response = await client.responses.create({
  model: "gpt-4.1",
  instructions: "You are an AI assistant. Help users with their requests.",
  input: "Write a limerick about JavaScript promises.",
});

console.log(response.output_text);
