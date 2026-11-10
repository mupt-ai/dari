import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";

import { promptMetrics } from "../../context/provider_prompt_accounting.js";
import { HttpError } from "../../http/errors.js";
import type { ProviderIdentity } from "../../interaction/types.js";
import { modelSupportsDocumentInput } from "../../providers/model_capabilities.js";
import { buildContext } from "../../providers/pi_context.js";
import { anthropicMessagesToInteraction } from "./anthropic_messages.js";
import { chatCompletionsToInteraction } from "./chat_completions.js";
import { openAIResponsesToInteraction } from "./openai_responses.js";

const CLAUDE: ProviderIdentity = { provider: "anthropic", api: "anthropic-messages", model: "claude-sonnet-5-5" };
const GLM: ProviderIdentity = { provider: "fireworks", api: "openai-completions", model: "glm-5p3" };
const PDF_BASE64 = "JVBERi0xLjQK";
const pdfSource = { type: "base64", media_type: "application/pdf", data: PDF_BASE64 };
const pdf = { type: "document", mimeType: "application/pdf", data: PDF_BASE64 };

function ingress(messages: unknown[]) {
  return anthropicMessagesToInteraction({ model: "dari/routing", max_tokens: 1024, messages } as never);
}

test("Anthropic ingress keeps PDFs native on user messages and inside tool results", () => {
  const request = ingress([
    { role: "user", content: [{ type: "text", text: "Summarize" }, { type: "document", source: pdfSource }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "document", source: pdfSource }] }] },
  ]);
  expect(request.items[0]).toMatchObject({ type: "message", content: [{ type: "text", text: "Summarize" }, pdf] });
  expect(request.items.find((item) => item.type === "tool_result")).toMatchObject({ output: [pdf] });
});

test("Anthropic ingress carries document title and context ahead of the document", () => {
  const request = ingress([
    { role: "user", content: [{ type: "document", source: pdfSource, title: "Q3 report", context: "Finance" }] },
  ]);
  expect(request.items[0]).toMatchObject({
    content: [{ type: "text", text: "Document: Q3 report\nFinance" }, pdf],
  });
});

test("Anthropic ingress turns text and content documents into text", () => {
  const request = ingress([{
    role: "user",
    content: [
      { type: "document", source: { type: "text", media_type: "text/plain", data: "Use tabs." } },
      { type: "document", source: { type: "content", content: [{ type: "text", text: "Chunk one" }] } },
    ],
  }]);
  expect(request.items[0]).toMatchObject({
    content: [{ type: "text", text: "Use tabs." }, { type: "text", text: "Chunk one" }],
  });
});

test("Anthropic ingress turns search results into text in messages and tool results", () => {
  const searchResult = {
    type: "search_result",
    source: "https://docs.example/a",
    title: "A",
    content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
    citations: { enabled: true },
  };
  const request = ingress([
    { role: "user", content: [searchResult] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Search", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [searchResult] }] },
  ]);
  const text = "Search result: A\nSource: https://docs.example/a\n\nfirst\nsecond";
  expect(request.items[0]).toMatchObject({ content: [{ type: "text", text }] });
  expect(request.items.find((item) => item.type === "tool_result")).toMatchObject({ output: [{ type: "text", text }] });
});

test("Anthropic ingress rejects document sources it cannot carry, naming the source", () => {
  const reject = (source: unknown) => () => ingress([{ role: "user", content: [{ type: "document", source }] }]);
  expect(reject({ type: "url", url: "https://x/a.pdf" })).toThrow(/source type 'url' is not supported/);
  expect(reject({ type: "file", file_id: "file_1" })).toThrow(HttpError);
  expect(reject({ ...pdfSource, media_type: "text/plain" })).toThrow(/must be application\/pdf/);
});

test("Responses ingress accepts base64 PDF input_file parts in messages and tool output", () => {
  const file = { type: "input_file", filename: "a.pdf", file_data: `data:application/pdf;base64,${PDF_BASE64}` };
  const request = openAIResponsesToInteraction({
    model: "dari/routing",
    input: [
      { role: "user", content: [file] },
      { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: [file] },
    ],
  });
  expect(request.items[0]).toMatchObject({ content: [pdf] });
  expect(request.items.find((item) => item.type === "tool_result")).toMatchObject({ output: [pdf] });
  expect(() =>
    openAIResponsesToInteraction({ model: "dari/routing", input: [{ role: "user", content: [{ type: "input_file", file_id: "file_1" }] }] })
  ).toThrow(/file_id and file_url are not supported/);
});

test("Chat Completions ingress accepts base64 PDF file parts", () => {
  const request = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [{
      role: "user",
      content: [{ type: "file", file: { filename: "a.pdf", file_data: `data:application/pdf;base64,${PDF_BASE64}` } }],
    }],
  } as never);
  expect(request.items[0]).toMatchObject({ content: [pdf] });
  expect(() =>
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [{ role: "user", content: [{ type: "file", file: { file_id: "file_1" } }] }],
    } as never)
  ).toThrow(/use a base64 PDF data URL/);
});

test("PDF capability requires both a PDF-reading owner and its native API", () => {
  const on = (api: string) => ({ model: { api } });
  expect(modelSupportsDocumentInput("anthropic/claude-sonnet-5-5", on("anthropic-messages"))).toBe(true);
  expect(modelSupportsDocumentInput("anthropic/claude-sonnet-5-5", on("bedrock-converse-stream"))).toBe(true);
  expect(modelSupportsDocumentInput("openai/gpt-5.6-sol", on("azure-openai-responses"))).toBe(true);
  expect(modelSupportsDocumentInput("openai/gpt-5.6-sol", on("openai-codex-responses"))).toBe(true);
  // Same APIs, owners whose PDF support is unverified.
  expect(modelSupportsDocumentInput("openai/gpt-5.6-sol", on("bedrock-converse-stream"))).toBe(false);
  expect(modelSupportsDocumentInput("xai/grok-4.7", on("openai-responses"))).toBe(false);
  expect(modelSupportsDocumentInput("zai-org/GLM-5.3", on("openai-completions"))).toBe(false);
});

test("PDFs reach PDF-capable targets natively and fail loudly elsewhere", () => {
  const request = ingress([{ role: "user", content: [{ type: "document", source: pdfSource }] }]);
  expect(buildContext(request, CLAUDE).messages).toMatchObject([
    { role: "user", content: [{ type: "document", mimeType: "application/pdf", data: PDF_BASE64 }] },
  ]);
  expect(() => buildContext(request, GLM)).toThrow(/not supported by the openai-completions API/);
});

test("prompt accounting estimates PDFs by page and never serializes them for incapable models", () => {
  const pages = (count: number) =>
    Buffer.from(`%PDF-1.4\n${"<< /Type /Page >>\n".repeat(count)}<< /Type /Pages >>`).toString("base64");
  const withPdf = (data: string) => ingress([
    { role: "user", content: [{ type: "document", source: { ...pdfSource, data } }] },
  ]);

  // Accounting runs for every configured model, including ones that cannot read PDFs.
  const one = promptMetrics(withPdf(pages(1)), GLM).serializedChars;
  const ten = promptMetrics(withPdf(pages(10)), GLM).serializedChars;
  expect(ten - one).toBe(9 * 3000 * 4);
  expect(one).toBeLessThan(20_000);

  // PDF 1.5+ can keep every page dictionary inside a compressed object stream.
  const compressed = (count: number) => {
    const objects = deflateSync("<< /Type /Page >>\n".repeat(count));
    return Buffer.concat([
      Buffer.from(`%PDF-1.5\n1 0 obj\n<< /Type /ObjStm /N ${count} /First 0 /Filter /FlateDecode /Length ${objects.length} >>\nstream\n`),
      objects,
      Buffer.from("\nendstream\nendobj\n%%EOF\n"),
    ]).toString("base64");
  };
  const hidden = promptMetrics(withPdf(compressed(7)), GLM).serializedChars;
  expect(hidden - one).toBeGreaterThanOrEqual(6 * 3000 * 4);

  // A compression bomb stops at the inflate budget: its 18MB of page dictionaries are never read.
  const bombObjects = deflateSync("<< /Type /Page >>\n".repeat(1_000_000));
  const bomb = Buffer.concat([
    Buffer.from(`%PDF-1.5\n1 0 obj\n<< /Type /ObjStm /Filter /FlateDecode /Length ${bombObjects.length} >>\nstream\n`),
    bombObjects,
    Buffer.from("\nendstream\nendobj\n%%EOF\n"),
  ]).toString("base64");
  expect(promptMetrics(withPdf(bomb), GLM).serializedChars).toBe(one);
});
