// Launch-scoped provider: the CLI reads these values from the loopback engine.
export default function (pi: any) {
  const { id, contextWindow, baseUrl } = JSON.parse(process.env.DARI_PI_ENGINE!);
  pi.registerProvider("dari-metal", {
    name: "Dari Metal", api: "openai-completions", baseUrl, apiKey: "local",
    models: [{ id, name: id, contextWindow, maxTokens: Math.max(1, Math.min(8192, Math.floor(contextWindow / 4))),
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
}
