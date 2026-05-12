/**
 * TDAI Memory Test Script
 *
 * 测试 TDAI 记忆功能是否正常工作。
 * 启动 Gateway，然后发送测试请求验证记忆捕获和召回。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { mkdir, rm, writeFile } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// 测试配置
const TEST_CONFIG = {
  server: {
    // Use 8422 by default to avoid clashing with the hermes sidecar on 8420.
    port: Number(process.env.TDAI_TEST_PORT || 8422),
    host: "127.0.0.1",
  },
  data: {
    baseDir: join(tmpdir(), "tdai-memory-test"),
  },
  llm: {
    baseUrl: process.env.TDAI_LLM_BASE_URL || "https://vdbteam.openai.azure.com/openai/v1",
    apiKey: process.env.TDAI_LLM_API_KEY || "",
    model: process.env.TDAI_LLM_MODEL || "gpt-5.2-chat",
    maxTokens: 4096,
    timeoutMs: 120000,
  },
};

// 用于接收 Gateway 回调的本地服务器
const callbackServer = createServer((req, res) => {
  console.log(`[Callback] ${req.method} ${req.url}`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
});

let gatewayProcess = null;

async function ensureDataDir() {
  await mkdir(TEST_CONFIG.data.baseDir, { recursive: true });
  const configPath = join(TEST_CONFIG.data.baseDir, "tdai-gateway.yaml");
  
  const configContent = `# TDAI Gateway Test Config
server:
  port: ${TEST_CONFIG.server.port}
  host: ${TEST_CONFIG.server.host}
data:
  baseDir: ${TEST_CONFIG.data.baseDir}
llm:
  baseUrl: ${TEST_CONFIG.llm.baseUrl}
  apiKey: ${TEST_CONFIG.llm.apiKey || "sk-test-key"}
  model: ${TEST_CONFIG.llm.model}
  maxTokens: ${TEST_CONFIG.llm.maxTokens}
  timeoutMs: ${TEST_CONFIG.llm.timeoutMs}
memory:
  capture:
    enabled: true
    l0l1RetentionDays: 7
  extraction:
    enabled: true
    enableDedup: true
  recall:
    enabled: true
    maxResults: 5
    scoreThreshold: 0.1
    strategy: hybrid
  pipeline:
    everyNConversations: 3
    enableWarmup: true
`;
  
  await writeFile(configPath, configContent);
  console.log(`[Config] Written to ${configPath}`);
}

function startCallbackServer() {
  const port = 18420;
  return new Promise((resolve, reject) => {
    callbackServer.listen(port, "127.0.0.1", () => {
      console.log(`[CallbackServer] Started on port ${port}`);
      resolve(port);
    });
    callbackServer.on("error", reject);
  });
}

function startGateway(callbackPort) {
  return new Promise((resolve, reject) => {
    const configPath = join(TEST_CONFIG.data.baseDir, "tdai-gateway.yaml");
    
    // Launch the TS source directly via npx/tsx (no dist build step required).
    const gatewayArgs = [
      "npx",
      "--yes",
      "tsx",
      "src/gateway/server.ts",
    ];

    console.log(`[Gateway] Starting with args:`, gatewayArgs);
    
    const env = {
      ...process.env,
      TDAI_GATEWAY_PORT: String(TEST_CONFIG.server.port),
      TDAI_GATEWAY_HOST: TEST_CONFIG.server.host,
      TDAI_DATA_DIR: TEST_CONFIG.data.baseDir,
      TDAI_LLM_BASE_URL: TEST_CONFIG.llm.baseUrl,
      TDAI_LLM_API_KEY: TEST_CONFIG.llm.apiKey,
      TDAI_LLM_MODEL: TEST_CONFIG.llm.model,
      TDAI_CALLBACK_PORT: String(callbackPort),
    };
    
    gatewayProcess = spawn(gatewayArgs[0], gatewayArgs.slice(1), {
      cwd: PROJECT_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    
    gatewayProcess.stdout?.on("data", (data) => {
      console.log(`[Gateway] ${data.toString().trim()}`);
    });
    
    gatewayProcess.stderr?.on("data", (data) => {
      console.error(`[Gateway Error] ${data.toString().trim()}`);
    });
    
    let healthCheckCount = 0;
    const maxHealthChecks = 30;
    const checkInterval = 1000;
    
    const checkHealth = () => {
      healthCheckCount++;
      
      const req = new Request(`http://${TEST_CONFIG.server.host}:${TEST_CONFIG.server.port}/health`);
      fetch(req)
        .then((res) => {
          if (res.ok) {
            resolve({ process: gatewayProcess, port: TEST_CONFIG.server.port });
            return;
          }
        })
        .catch(() => {});
      
      if (healthCheckCount >= maxHealthChecks) {
        reject(new Error("Gateway failed to start"));
      }
      
      setTimeout(checkHealth, checkInterval);
    };
    
    setTimeout(checkHealth, checkInterval);
    
    gatewayProcess.on("error", (err) => {
      reject(new Error(`Failed to start gateway: ${err.message}`));
    });
  });
}

async function testHealthCheck(gatewayPort) {
  console.log("\n[Test] Health check...");
  try {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/health`);
    const data = await res.json();
    console.log(`[OK] Health check passed:`, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error(`[FAIL] Health check failed:`, err.message);
    return false;
  }
}

async function testCapture(gatewayPort) {
  console.log("\n[Test] Capture conversation...");
  try {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_content: "你好，我是一个测试用户。我喜欢编程和咖啡。",
        assistant_content: "你好！很高兴认识你。编程和咖啡都是很棒的爱好！",
        session_key: "test-session-001",
        session_id: "test-session-id-001",
        user_id: "test-user",
      }),
    });
    const data = await res.json();
    console.log(`[OK] Capture response:`, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error(`[FAIL] Capture failed:`, err.message);
    return false;
  }
}

async function testRecall(gatewayPort) {
  console.log("\n[Test] Recall memories...");
  try {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "用户的爱好是什么？",
        session_key: "test-session-001",
        user_id: "test-user",
      }),
    });
    const data = await res.json();
    console.log(`[OK] Recall response:`, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error(`[FAIL] Recall failed:`, err.message);
    return false;
  }
}

async function testSearchMemories(gatewayPort) {
  console.log("\n[Test] Search memories...");
  try {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/search/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "编程",
        limit: 5,
        type: "episode",
      }),
    });
    const data = await res.json();
    console.log(`[OK] Search memories response:`, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error(`[FAIL] Search memories failed:`, err.message);
    return false;
  }
}

async function stopGateway() {
  if (gatewayProcess) {
    console.log("\n[Cleanup] Stopping gateway...");
    gatewayProcess.kill("SIGTERM");
    gatewayProcess = null;
  }
  if (callbackServer.listening) {
    callbackServer.close();
  }
}

async function cleanup() {
  await stopGateway();
  // 不删除测试数据目录，保留用于调试
  console.log("[Cleanup] Test data preserved at:", TEST_CONFIG.data.baseDir);
}

async function main() {
  console.log("=".repeat(60));
  console.log("TDAI Memory Test");
  console.log("=".repeat(60));
  
  const results = {
    health: false,
    capture: false,
    recall: false,
    search: false,
  };
  
  try {
    // 1. 确保数据目录存在
    await ensureDataDir();
    
    // 2. 启动回调服务器
    const callbackPort = await startCallbackServer();
    
    // 3. 启动 Gateway
    const { port: gatewayPort } = await startGateway(callbackPort);
    
    // 等待 Gateway 完全启动
    await new Promise((resolve) => setTimeout(resolve, 2000));
    
    // 4. 运行测试
    results.health = await testHealthCheck(gatewayPort);
    if (results.health) {
      // 等待一下让 Gateway 初始化
      await new Promise((resolve) => setTimeout(resolve, 1000));
      results.capture = await testCapture(gatewayPort);
      if (results.capture) {
        // 等待提取完成
        await new Promise((resolve) => setTimeout(resolve, 3000));
        results.recall = await testRecall(gatewayPort);
        results.search = await testSearchMemories(gatewayPort);
      }
    }
    
  } catch (err) {
    console.error("\n[Test] Error:", err.message);
  } finally {
    await cleanup();
    
    // 打印测试结果
    console.log("\n" + "=".repeat(60));
    console.log("Test Results:");
    console.log("=".repeat(60));
    console.log(`  Health Check:  ${results.health ? "PASS" : "FAIL"}`);
    console.log(`  Capture:       ${results.capture ? "PASS" : "FAIL"}`);
    console.log(`  Recall:        ${results.recall ? "PASS" : "FAIL"}`);
    console.log(`  Search:        ${results.search ? "PASS" : "FAIL"}`);
    
    const passed = Object.values(results).filter(Boolean).length;
    console.log(`\nTotal: ${passed}/4 passed`);
  }
}

main().catch(console.error);
