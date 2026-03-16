# 刘胜利的博客

基于 [Hugo](https://gohugo.io/) + [PaperMod](https://github.com/adityatelange/hugo-PaperMod) 主题构建。

## 本地开发

```bash
# 克隆项目（包含主题子模块）
git clone --recurse-submodules git@github.com:ThReeIOne/blog.git
cd blog

# 本地预览
hugo server -D

# 访问 http://localhost:1313
```

## 部署

push 到 `main` 分支后，GitHub Actions 自动构建并部署到服务器。

### 配置 GitHub Secrets

在仓库 Settings → Secrets and variables → Actions 中添加：

| Secret | 说明 |
|--------|------|
| `SERVER_HOST` | 服务器 IP |
| `SERVER_USER` | SSH 用户名（如 root） |
| `SERVER_SSH_KEY` | SSH 私钥内容 |

### 服务器 Nginx 配置

```bash
# 复制配置文件
cp deploy/nginx.conf /etc/nginx/sites-available/blog
ln -s /etc/nginx/sites-available/blog /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### 配置 HTTPS（域名买好后）

```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

## 写新文章

```bash
hugo new posts/文章名.md
# 编辑文章，将 draft: true 改为 false
git add . && git commit -m "新文章" && git push
```
