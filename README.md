# 考研单词学习

纯静态的考研词汇（红宝书）记忆 + 打字练习网页，无构建、无依赖，双击 `index.html` 即可运行。

## 目录结构

```
index.html            页面骨架（顶部导航 / 学习 / 统计 / 词库 / 设置）
assets/style.css      全部样式（含深浅色主题变量）
assets/app.js         全部交互逻辑（最容易被多人同时改）
assets/words.js       词库数据（由 _data/build.js 自动生成，不要手改）
assets/hands.js       键盘手部图层（由 _data/build-hands.js 自动生成，不要手改）
assets/hand-both.svg  手部插图源文件
assets/vendor/        第三方库（pinyin-pro）
_data/build.js        数据构建脚本：读 CSV + 音标库，输出 assets/words.js
_data/build-hands.js  图层构建脚本：读手部 SVG，输出 assets/hands.js
_data/红宝书源.csv     原始词表
_data/en_US.txt       音标库
```

> `assets/hands.js` 是 58 个 SVG 图层的拼接产物（左/右手各一层按状态切换），
> 体积大、全是压缩路径，出问题不要手改，改 `hand-both.svg` 后重新生成。

## 需要装什么

| 工具 | 版本 | 用途 | 必需 |
| --- | --- | --- | --- |
| VS Code | 最新版 | 写代码（两人都用它，配置已随仓库同步） | 是 |
| Git | 2.30+ | 版本管理 | 是 |
| Node.js | 18+ | 只有改词库、跑 `npm run build` 时才用 | 否 |
| GitHub 账号 | — | 远程仓库与协作 | 是 |

VS Code 打开项目后会提示安装推荐插件（Live Server / GitLens / 中文包），点「安装」即可。
见 `.vscode/extensions.json`。

## 本地运行

直接双击 `index.html`。若浏览器对本地文件有限制，可在项目根目录起一个静态服务：

```bash
python -m http.server 8000
# 然后访问 http://localhost:8000
```

## 重新生成数据

```bash
npm run build         # 读 _data/红宝书源.csv + en_US.txt → assets/words.js
npm run build:hands   # 读 assets/hand-both.svg          → assets/hands.js
```

> 注意：`build.js` 里有一个写死的备用路径 `C:/Users/王鹏辉/Desktop/...`。
> 换机器后如果报找不到文件，把那段 fallback 删掉，只保留 `_data/红宝书源.csv`。

## 协作约定

### 0. 严禁 `git push --force`

**强推会直接抹掉对方已经推上来的提交。** 11-04 就发生过一次：远端被强推回旧历史，
README、package.json、`.vscode` 配置、`.gitattributes` 全部丢失，需要人工找回。

只在一种情况下可以强推：**你确信远端那些提交是垃圾、且已经和对方确认过**。

推送被拒（`! [rejected]`）时的正确做法是 `git pull --rebase` 再 push，不是 `-f`。

### 1. 不要直接往 `main` 上提交

每个人都在自己的分支上干活，改完发 PR / 合并请求。

```bash
git switch main && git pull            # 开工前先同步
git switch -c feat/typing-mode         # 建自己的分支
# ... 改代码 ...
git add -A && git commit -m "feat: 打字模式加入错误统计"
git push -u origin feat/typing-mode    # 推上去，然后在网页上发起 PR
```

分支命名：`feat/xxx` 新功能，`fix/xxx` 修 bug，`data/xxx` 只动词库数据。

### 2. 分工尽量按文件切

`app.js` 是单文件，两个人同时改同一个函数一定会冲突。建议按模块认领：

| 模块 | 位置 |
| --- | --- |
| 页面结构与导航 | `index.html` |
| 学习卡片 / 打字判分逻辑 | `assets/app.js` 中的 drill 相关函数 |
| 统计视图、图表 | `assets/app.js` 中的 stats 相关函数 |
| 样式与主题 | `assets/style.css` |
| 指法提示 / 手部图层 | `assets/hands.js` + `_data/build-hands.js` |
| 词库与音标数据 | `_data/` + `assets/words.js` |

需要同时改一个函数时，先在群里说一声，或者一个人先提交、另一个再 `git pull --rebase`。

### 3. 每次开工前先拉，收工后先推

```bash
git pull --rebase
```

### 4. 脚本产物不要让两个人同时生成

`assets/words.js`、`assets/hands.js` 都是构建产物，冲突了几乎没法手工合。
约定：谁负责那份数据，谁跑构建脚本，别两边同时生成。

## 冲突了怎么办

```bash
git status                 # 看哪些文件冲突
# 打开冲突文件，处理 <<<<<<< ======= >>>>>>> 三段
git add <冲突文件>
git rebase --continue      # 如果是 rebase；merge 则用 git commit
```

`words.js` 冲突不想手改的话：

```bash
git checkout --theirs assets/words.js   # 先接受对方版本
node _data/build.js                     # 再用当前 CSV 重新生成
git add assets/words.js && git rebase --continue
```
