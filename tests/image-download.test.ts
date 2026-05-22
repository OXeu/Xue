/**
 * tests/image-download.test.ts — downloadImage 单元测试
 *
 * 覆盖：成功下载、HTTP 错误、网络异常、空响应、MIME 推断与回退。
 * 所有测试 mock globalThis.fetch，测试完成后恢复。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { downloadImage } from "../src/image-download";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("downloadImage", () => {
  test("成功下载并返回 base64 + mime", async () => {
    const body = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    globalThis.fetch = async () => new Response(body, {
      status: 200,
      headers: { "content-type": "image/png" },
    });

    const result = await downloadImage("https://example.com/img.png");
    expect(result).not.toBeNull();
    expect(result!.mime).toBe("image/png");
    expect(result!.base64).toBe(Buffer.from(body).toString("base64"));
  });

  test("HTTP 200 但无 Content-Type → 回退到 image/jpeg", async () => {
    const body = new Uint8Array([0xFF, 0xD8, 0xFF]);
    globalThis.fetch = async () => new Response(body, { status: 200 });

    const result = await downloadImage("https://example.com/img.jpg");
    expect(result).not.toBeNull();
    expect(result!.mime).toBe("image/jpeg");
    expect(result!.base64).toBe(Buffer.from(body).toString("base64"));
  });

  test("HTTP 错误（404）→ 返回 null", async () => {
    globalThis.fetch = async () => new Response("Not Found", { status: 404 });

    const result = await downloadImage("https://example.com/notfound");
    expect(result).toBeNull();
  });

  test("HTTP 错误（500）→ 返回 null", async () => {
    globalThis.fetch = async () => new Response("Server Error", { status: 500 });

    const result = await downloadImage("https://example.com/error");
    expect(result).toBeNull();
  });

  test("fetch 抛出异常（网络错误）→ 返回 null", async () => {
    globalThis.fetch = async () => { throw new Error("network timeout"); };

    const result = await downloadImage("https://example.com/timeout");
    expect(result).toBeNull();
  });

  test("空响应体（0 字节）→ 返回 null", async () => {
    globalThis.fetch = async () => new Response(new Uint8Array(0), {
      status: 200,
      headers: { "content-type": "image/png" },
    });

    const result = await downloadImage("https://example.com/empty");
    expect(result).toBeNull();
  });

  test("AbortSignal 超时异常 → 返回 null", async () => {
    globalThis.fetch = async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    };

    const result = await downloadImage("https://example.com/slow");
    expect(result).toBeNull();
  });

  test("非图片 Content-Type 保持原样返回", async () => {
    const body = new TextEncoder().encode("some text data");
    globalThis.fetch = async () => new Response(body, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });

    const result = await downloadImage("https://example.com/data.bin");
    expect(result).not.toBeNull();
    expect(result!.mime).toBe("application/octet-stream");
    expect(result!.base64).toBe(Buffer.from(body).toString("base64"));
  });

  test("不抛出异常（非 Error 类型的 throw 也静默返回 null）", async () => {
    globalThis.fetch = async () => { throw "something went wrong"; };

    const result = await downloadImage("https://example.com/crash");
    expect(result).toBeNull();
  });
});
