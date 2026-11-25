# Git 交付清单

我想在本机项目目录里查看最近交付的提交，并把结果粘贴到周报。请按下列顺序交付两项，每项保留单独的 Git 提交。已有验收用例和本文件是固定输入。

1. Git 历史读取。在 history.mjs 导出 readCommits(limit)，在当前工作目录读取最近的 limit 个提交，按从新到旧返回 {sha, subject} 的数组。sha 为完整提交 SHA，subject 为提交标题。验收用例 history.check.mjs，对应必需检查 history。
2. Markdown 命令。在第一项交付后新增 checklist.mjs。运行 node checklist.mjs 2，从第一项的 readCommits(2) 获取最近两项，每行输出一个 Markdown 勾选项，格式为 `- [x] <SHA 前七位> <提交标题>`，最后以换行结束。验收用例 markdown.check.mjs，对应必需检查 markdown。
