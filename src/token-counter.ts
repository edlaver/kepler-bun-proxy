import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

export class TokenCounter {
  private readonly encoder = new Tiktoken(o200kBase);

  countTokens(text: string): number {
    return this.encoder.encode(text).length;
  }
}
