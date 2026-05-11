# Changelog

本文件记录 `@tencentdb-agent-memory/memory-tencentdb` 插件的所有显著变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/)。

---

## [0.1.4] - 2026-04-10

### 🚀 Features

- *(auto-recall)* Add recall hint text before memories

## [0.1.3] - 2026-04-09

### 🚀 功能

- *(memory-tdai)* 用 reporter 抽象替换 emitMetric
- *(L3)* L3 使用读写工具，防止模型输出 CoT
- *(memory)* 添加 embedding 截断、召回超时，以及从 L0 捕获中剔除代码块
- *(config)* Embedding 超时支持配置
- *(report)* 在 schema 中暴露 report 配置项，默认值改为 false

### 🐛 修复

- *(capture)* 跳过心跳/定时任务/自动化/调度类消息
- *(recall)* 召回完成时清除超时定时器，避免误报超时警告

### 💼 Other

- 重命名包名为 memory-tencentdb
- *(deps)* 将 node-llama-cpp 改为可选依赖

### ⚡ 性能

- *(auto-capture)* 将 L0 向量嵌入移至后台以降低延迟

### 📚 文档

- 添加 allowPromptInjection 配置警告说明

## [0.1.2] — 2026-03-26

### 更新内容

1. 优化对话捕获与记忆抽取过滤机制

## [0.1.1] — 2026-03-25

### 更新内容

1. 兼容 openclaw 2026.3.23 更新

## [0.1.0] — 2026-03-25

> 首个正式发布版本。本地优先的四层记忆系统（L0→L1→L2→L3），基于 SQLite + LLM 实现对话捕获、记忆提取、场景归纳与用户画像。

### 更新内容

1. 关键字检索增加 FTS5 全文索引，采用 jieba 分词
2. 未配置远程 embedding 服务时，默认不开启 embedding 能力（不自动使用本地 embedding，且封禁主动使用本地 embedding 的配置入口）
3. 优化 L2、L3 生成 prompt 以控制生成内容大小（减少 token 开销）
4. Pipeline 调度器优化文件锁用法
5. 避免全量读取 L0、L1 数据
