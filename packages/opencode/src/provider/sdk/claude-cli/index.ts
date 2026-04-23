import type { LanguageModelV3 } from "@ai-sdk/provider"
import { ClaudeCliLanguageModel } from "./language-model"

export interface ClaudeCliProviderSettings {
  binary?: string
  extraArgs?: string[]
}

export interface ClaudeCliProvider {
  languageModel(modelId: string): LanguageModelV3
  (modelId: string): LanguageModelV3
}

export function createClaudeCli(settings: ClaudeCliProviderSettings = {}): ClaudeCliProvider {
  const binary = settings.binary ?? "claude"
  const extraArgs = settings.extraArgs ?? []

  const create = (modelId: string): LanguageModelV3 =>
    new ClaudeCliLanguageModel({ binary, modelId, extraArgs })

  return Object.assign(create, {
    languageModel: create,
  }) as ClaudeCliProvider
}

export { ClaudeCliLanguageModel } from "./language-model"
