## 关键文件

（读 Node/TS 项目时很常见的区分。）
- main.ts cli 入口，面向用户运行时候使用的 pi 命令
- index.ts 导出库，别的代码需要使用导入这个包，面向的是其他代码

## main.ts 主流程理解
1. 先处理特殊命令，比如 package 等等，这个不会启动 agent 而是处理完就退出
2. 跑 migration ，这一步就是为了升级后兼容旧的配置，迁移到新版本，启动的时候顺手做一些升级
3. 第一次解析参数（很关键，解析显示传入了哪些 extension、Skills、themes、prompts、template 等等）先加载起来
   tips: 这个第一次很关键，因为扩展允许添加自己的 CLI flags
4. 加载资源，把前面第三步传入的资源都加载进来
5. 第二次解析参数，这时候就能解析扩展添加的 CLI flags 了，这个设计值得学习！
6. 处理帮助、版本、列出模型、导出等等，这些不需要启动 agent
7. 准备初始消息，在这处理 @file 参数，图片会转成image content，拼出来给模型的初始化消息
8. 创建 session manager，这一步决定新建、继续、打开指定、或者恢复之前的session，这是会话层
9. 组装 agent 需要的所有参数
10. 按模式开始运行三种模式，RPC、Interactive、Print（RPC调用、脚本化调用、单次问答输出）

## args.ts 
几乎就是把命令行 token 转成一个结构化对象 
- Args 对象定义
   - provider?: string 表示可选
   - messages: string[] 表示字符串数组
   - unknownFlags: Map<string, boolean | string> 表示一个 map，key 是字符串，value 是布尔或字符串
   - Mode = "text" | "json" | "rpc"，联合字符串，理解为枚举
- parseArgs 解析手法非常朴素，很适合学习，不抽象，不绕
  - result.extensions = result.extensions ?? []; 空值合并，类似于三目表达式
- isValidThinkingLevel(level: string): level is ThinkingLevel 类型守卫，如果返回 true，ts 就认为level是个正确的ThinkingLevel

## 数据流概念
- 命令行参数 main.js
  - 解析参数
  - 组装配置
  - 创建会话 session
  - 开始运行


## 一张脑图式理解
- cli.ts：命令入口
- main.ts：总调度

### 中层

- cli/args.ts：参数解析
- core/sdk.ts：创建 session 的工厂
- core/agent-session.ts：核心会话逻辑

### 支撑层

- core/tools/*：工具
- core/session-manager.ts：会话存储
- core/model-*：模型解析和注册
- core/extensions/*：扩展系统
- modes/*：不同运行方式
