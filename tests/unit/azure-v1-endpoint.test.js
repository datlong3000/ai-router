import { describe, it, expect } from "vitest";
import { AzureExecutor } from "open-sse/executors/azure.js";

const psd = (azureEndpoint) => ({ providerSpecificData: { azureEndpoint, deployment: "dep-1", apiVersion: "2024-10-21" } });

describe("AzureExecutor endpoint styles", () => {
  const e = new AzureExecutor();
  it("classic resource endpoint → deployments path + api-version", () => {
    expect(e.buildUrl("m", false, 0, psd("https://r.openai.azure.com/")))
      .toBe("https://r.openai.azure.com/openai/deployments/dep-1/chat/completions?api-version=2024-10-21");
    expect(e.transformRequest("m", { model: "m" }, false, psd("https://r.openai.azure.com"))).toEqual({ model: "m" });
  });
  it("v1 endpoint (/openai/v1) → /chat/completions, deployment in body.model", () => {
    expect(e.buildUrl("m", false, 0, psd("https://r.openai.azure.com/openai/v1/")))
      .toBe("https://r.openai.azure.com/openai/v1/chat/completions");
    expect(e.transformRequest("m", { model: "m" }, false, psd("https://r.openai.azure.com/openai/v1"))).toEqual({ model: "dep-1" });
  });
});
