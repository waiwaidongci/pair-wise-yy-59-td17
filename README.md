# pair-wise-yy-59 法律文件披露、去密与发布质控工作台

用于诉讼披露批次中的区域去密、原页/发布页双人复核、文档标签和发布门禁。PDF.js 真实渲染示例文档，去密区域可绘制、确认并持久化到本地草稿。

## 技术栈

React、Radix UI 风格组件、Zustand、TanStack Router、TanStack Query、PDF.js、Vite、TypeScript。

## 运行

```bash
npm install
npm run dev
```

访问 `http://localhost:62059`。示例 PDF 由浏览器端生成后交给 PDF.js 渲染，不需要外部文件。

```bash
npm run build
```
