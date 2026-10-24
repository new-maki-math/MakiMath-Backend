/**
 * MakiMath 后端一键部署脚本
 *
 * 用法：
 *   node scripts/deploy.js          # 或 npm run deploy
 *
 * 流程：
 *   1. 读取 backend/deploy.config.json（可用 DEPLOY_* 环境变量覆盖敏感字段）
 *   2. 收集本地后端源码（排除 node_modules / data / .env / deploy.config.json）
 *   3. SSH 上传到服务器临时目录
 *   4. 远程准备 Node.js 22 + pm2（按需安装 PostgreSQL）
 *   5. 同步代码到远端 backend 目录，生成或保留 .env
 *   6. npm install --omit=dev，必要时初始化数据库与表结构
 *   7. pm2 重启服务并做 /health 健康检查
 *
 * deploy.config.json 支持的字段：
 *   host            服务器地址（必填）
 *   port            SSH 端口，默认 22
 *   username        SSH 用户（必填，建议 root）
 *   password        SSH 密码（必填）
 *   remoteBaseDir   远端根目录，默认 /var/www/maki-math
 *   backendPort     后端监听端口，默认 3000
 *   pm2Name         pm2 进程名，默认 maki-math-backend
 *   setupDatabase   是否自动安装 / 初始化 PostgreSQL，默认 true
 *   forceSchema     清库重建开关，默认 false / 省略。
 *                   只有写成字符串 "DROP_AND_REBUILD" 才会执行
 *                   DROP SCHEMA public CASCADE 并重跑 Database/schema.sql。
 *                   这是销毁性操作：全部业务数据清空，超管重置为 makimath_root。
 *                   不支持写 true（会被拒绝），避免手滑误删。
 *   db              { name, user, password }，setupDatabase 为 true 时必填；
 *                   name 与 user 只允许字母数字下划线，password 不能含空白
 *   env             可选，写进远端 .env 的键值对；提供时会自动补上 PGHOST/PGUSER 等数据库连接项。
 *                   必须同时给出 JWT_SECRET 与 PAYLOAD_SECRET_KEY，后者需正好 32 字节。
 *
 * 注意：不填 env 时，若服务器上已有 .env 则原样保留；若也没有，脚本会用随机密钥生成一份。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { NodeSSH } from "node-ssh"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "..")
const configPath = path.join(rootDir, "deploy.config.json")

if (!fs.existsSync(configPath)) {
  console.error("未找到 backend/deploy.config.json，请先参考 deploy.config.example.json 补充部署配置。")
  process.exit(1)
}

const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"))
const config = {
  host: process.env.DEPLOY_HOST || fileConfig.host,
  port: Number(process.env.DEPLOY_PORT || fileConfig.port || 22),
  username: process.env.DEPLOY_USERNAME || fileConfig.username,
  password: process.env.DEPLOY_PASSWORD || fileConfig.password,
  remoteBaseDir: process.env.DEPLOY_BASE_DIR || fileConfig.remoteBaseDir || "/var/www/maki-math",
  backendPort: Number(process.env.DEPLOY_BACKEND_PORT || fileConfig.backendPort || 3000),
  pm2Name: process.env.DEPLOY_PM2_NAME || fileConfig.pm2Name || "maki-math-backend",
  setupDatabase: fileConfig.setupDatabase !== false,
  // 只有字面量 "DROP_AND_REBUILD" 才触发清库重建，避免 true/false 手滑造成数据丢失
  forceSchema: (process.env.DEPLOY_FORCE_SCHEMA || fileConfig.forceSchema) === "DROP_AND_REBUILD",
  forceSchemaRaw: process.env.DEPLOY_FORCE_SCHEMA || fileConfig.forceSchema,
  db: {
    name: fileConfig.db?.name || "maki_math",
    user: fileConfig.db?.user || "maki",
    password: fileConfig.db?.password || "",
  },
  env: fileConfig.env && typeof fileConfig.env === "object" && !Array.isArray(fileConfig.env)
    ? fileConfig.env
    : null,
}

if (!config.host || !config.username || !config.password || !config.remoteBaseDir) {
  console.error("部署配置不完整，请检查 deploy.config.json 或环境变量（host / username / password / remoteBaseDir）。")
  process.exit(1)
}

if (config.forceSchemaRaw !== undefined && config.forceSchemaRaw !== false && !config.forceSchema) {
  console.error(
    `forceSchema 只接受 "DROP_AND_REBUILD" 字面量（或省略/false）。\n` +
      `  收到的是 ${JSON.stringify(config.forceSchemaRaw)}——它会清空数据库全部业务数据，\n` +
      `  所以不支持用 true 简写。确需重建请写成 "forceSchema": "DROP_AND_REBUILD"。`,
  )
  process.exit(1)
}

if (config.setupDatabase) {
  if (!config.db.name || !config.db.user || !config.db.password) {
    console.error("已启用 setupDatabase，但 db.name / db.user / db.password 未配置完整。")
    process.exit(1)
  }
  // 库名与用户名会直接拼进 SQL，只允许安全的标识符字符
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.db.name)) {
    console.error(`db.name 只能由字母、数字、下划线组成且不能以数字开头，当前为 ${JSON.stringify(config.db.name)}。`)
    process.exit(1)
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.db.user)) {
    console.error(`db.user 只能由字母、数字、下划线组成且不能以数字开头，当前为 ${JSON.stringify(config.db.user)}。`)
    process.exit(1)
  }
  if (/\s/.test(config.db.password)) {
    console.error("db.password 不能包含空格或换行，请改用字母数字组合的强密码。")
    process.exit(1)
  }
}

// env 字段一旦显式提供，就必须带上生产可用的密钥，避免上线后沿用开发默认值
if (config.env) {
  const jwt = config.env.JWT_SECRET
  const payloadKey = config.env.PAYLOAD_SECRET_KEY
  if (!jwt || !payloadKey) {
    console.error("env 字段必须同时包含 JWT_SECRET 与 PAYLOAD_SECRET_KEY，否则会退回代码里的开发默认密钥。")
    process.exit(1)
  }
  if (Buffer.byteLength(String(payloadKey), "utf8") !== 32) {
    console.error(`PAYLOAD_SECRET_KEY 必须正好 32 字节，当前为 ${Buffer.byteLength(String(payloadKey), "utf8")} 字节。`)
    process.exit(1)
  }
}

const ssh = new NodeSSH()
let localEnvTmp = null
const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
const remoteTmpBase = `/tmp/maki-backend-deploy-${timestamp}`
const remoteUploadDir = `${remoteTmpBase}/backend`
const remoteEnvFile = `${remoteTmpBase}/deploy.env`
const remoteBackendDir = `${config.remoteBaseDir}/backend`

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

function toPosixPath(value) {
  return value.replaceAll("\\", "/")
}

function shouldUpload(itemPath) {
  const rel = toPosixPath(path.relative(rootDir, itemPath))
  if (!rel || rel === "." || rel.startsWith("..")) return true
  const segments = rel.split("/")
  if (segments.includes("node_modules")) return false
  if (segments.includes(".git")) return false
  // 远端运行时数据目录由服务器自己维护，不上传也不覆盖
  if (segments[0] === "data") return false
  const base = segments[segments.length - 1]
  if (base === ".env") return false
  if (base === "deploy.config.json") return false
  if (base.endsWith(".log")) return false
  return true
}

function collectFiles(baseDir, currentDir = baseDir, files = []) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true })
  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name)
    if (entry.isDirectory()) {
      collectFiles(baseDir, absolutePath, files)
      continue
    }
    if (!entry.isFile()) {
      continue
    }
    if (!shouldUpload(absolutePath)) {
      continue
    }
    files.push({
      absolutePath,
      relativePath: toPosixPath(path.relative(baseDir, absolutePath)),
    })
  }
  return files
}

function buildEnvContent(envObject) {
  const lines = ["# 由 backend/scripts/deploy.js 依据 deploy.config.json 的 env 字段生成"]
  for (const [key, value] of Object.entries(envObject)) {
    lines.push(`${key}=${value}`)
  }
  return `${lines.join("\n")}\n`
}

// 显式提供了 env 时，把数据库连接信息一并写入，保证与服务器上实际创建的库一致
function resolveEnvObject() {
  if (!config.env) return null
  const merged = {}
  if (config.setupDatabase) {
    Object.assign(merged, {
      PGHOST: "127.0.0.1",
      PGPORT: "5432",
      PGUSER: config.db.user,
      PGPASSWORD: config.db.password,
      PGDATABASE: config.db.name,
    })
  }
  return Object.assign(merged, config.env)
}

async function main() {
  const serverEntry = path.join(rootDir, "src", "server.js")
  if (!fs.existsSync(serverEntry)) {
    throw new Error("未找到 src/server.js，请在 backend 目录下执行部署脚本")
  }

  const uploadFiles = collectFiles(rootDir)
  if (uploadFiles.length === 0) {
    throw new Error("没有可上传的后端文件")
  }
  console.log(`准备上传 ${uploadFiles.length} 个后端文件...`)

  if (config.env) {
    localEnvTmp = path.join(os.tmpdir(), `maki-backend-env-${timestamp}.env`)
    fs.writeFileSync(localEnvTmp, buildEnvContent(resolveEnvObject()), { encoding: "utf8", mode: 0o600 })
    console.log("已根据 deploy.config.json 的 env 字段生成远端 .env")
  }

  console.log(`开始连接 ${config.username}@${config.host}:${config.port} ...`)

  await ssh.connect({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    tryKeyboard: false,
  })

  console.log("连接成功，准备上传后端文件...")

  const remotePrep = await ssh.execCommand(`
set -e
mkdir -p ${quote(remoteUploadDir)}
mkdir -p ${quote(remoteBackendDir)}
mkdir -p ${quote(`${remoteBackendDir}/data/pdfs`)}
mkdir -p ${quote(`${remoteBackendDir}/data/images`)}
`)

  if (remotePrep.code !== 0) {
    throw new Error(remotePrep.stderr || "远程目录初始化失败")
  }

  let uploadedCount = 0
  const uploaded = await ssh.putDirectory(rootDir, remoteUploadDir, {
    recursive: true,
    concurrency: 8,
    validate: (itemPath) => shouldUpload(itemPath),
    tick: (localPath, _remotePath, error) => {
      if (error) {
        return
      }
      const stat = fs.existsSync(localPath) ? fs.statSync(localPath) : null
      if (!stat?.isFile()) {
        return
      }
      uploadedCount += 1
      console.log(`[${uploadedCount}/${uploadFiles.length}] ${toPosixPath(path.relative(rootDir, localPath))}`)
    },
  })

  if (!uploaded) {
    throw new Error("后端文件上传失败")
  }

  if (localEnvTmp) {
    await ssh.putFile(localEnvTmp, remoteEnvFile)
  }

  console.log("上传完成，开始远程部署后端...")

  const deployScript = `
set -e

export DEBIAN_FRONTEND=noninteractive

BACKEND_DIR=${quote(remoteBackendDir)}
UPLOAD_DIR=${quote(remoteUploadDir)}
TMP_DIR=${quote(remoteTmpBase)}
PM2_NAME=${quote(config.pm2Name)}
APP_PORT=${quote(String(config.backendPort))}
DB_NAME=${quote(config.db.name)}
DB_USER=${quote(config.db.user)}
DB_PASS=${quote(config.db.password)}
SETUP_DB=${config.setupDatabase ? "1" : "0"}
REBUILD_SCHEMA=${config.forceSchema ? "1" : "0"}
ENV_SRC=${localEnvTmp ? quote(remoteEnvFile) : "''"}

step() { echo; echo "==> $1"; }

rand_hex() {
  openssl rand -hex "$1"
}

# ---------- 1. Node.js 运行时 ----------
step "检查 Node.js 运行时"
if ! command -v curl >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
  apt-get update
  apt-get install -y curl ca-certificates openssl
fi

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  step "当前 Node.js $(node -v) 低于 22，正在升级"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "Node.js $(node -v)"

# ---------- 2. pm2 ----------
step "检查 pm2 进程守护"
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi
echo "pm2 $(pm2 -v)"

# ---------- 3. 同步代码 ----------
step "同步后端代码到 $BACKEND_DIR"
mkdir -p "$BACKEND_DIR" "$BACKEND_DIR/data/pdfs" "$BACKEND_DIR/data/images"
find "$BACKEND_DIR" -mindepth 1 -maxdepth 1 ! -name data ! -name .env -exec rm -rf {} +
cp -a "$UPLOAD_DIR/." "$BACKEND_DIR/"

# ---------- 4. .env ----------
step "配置环境变量文件 .env"
if [ -n "$ENV_SRC" ] && [ -f "$ENV_SRC" ]; then
  install -m 600 "$ENV_SRC" "$BACKEND_DIR/.env"
  echo "已按 deploy.config.json 的 env 字段写入 .env"
elif [ -f "$BACKEND_DIR/.env" ]; then
  chmod 600 "$BACKEND_DIR/.env"
  echo "检测到服务器已有 .env，保持不变"
elif [ "$SETUP_DB" = "1" ]; then
  JWT_SECRET_VAL="$(rand_hex 32)"
  PAYLOAD_KEY_VAL="$(rand_hex 16)"
  cat > "$BACKEND_DIR/.env" <<EOF
NODE_ENV=production
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=$DB_USER
PGPASSWORD=$DB_PASS
PGDATABASE=$DB_NAME
HOST=127.0.0.1
PORT=$APP_PORT
# 生产走 nginx 反代，必须信任回环代理才能拿到真实客户端 IP
TRUST_PROXY=loopback
LOG_LEVEL=info
JWT_SECRET=$JWT_SECRET_VAL
PAYLOAD_SECRET_KEY=$PAYLOAD_KEY_VAL
EOF
  chmod 600 "$BACKEND_DIR/.env"
  echo "已生成 .env（JWT_SECRET 与 PAYLOAD_SECRET_KEY 为随机值）"
else
  echo "缺少 $BACKEND_DIR/.env 且未启用数据库初始化，无法继续部署。" >&2
  exit 1
fi

# 以 .env 中实际写入的 PORT 为准，避免与 backendPort 不一致导致健康检查误判
ENV_PORT="$(grep -E '^PORT=' "$BACKEND_DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2 | tr -d '\\r\\"' || true)"
if [ -n "$ENV_PORT" ]; then
  APP_PORT="$ENV_PORT"
fi
echo "服务监听端口：$APP_PORT"

# ---------- 5. 安装依赖 ----------
step "安装生产依赖"
cd "$BACKEND_DIR"
npm install --omit=dev --no-audit --no-fund

# ---------- 6. PostgreSQL ----------
if [ "$SETUP_DB" = "1" ]; then
  step "检查 PostgreSQL"
  if ! command -v psql >/dev/null 2>&1; then
    apt-get update
    apt-get install -y postgresql postgresql-contrib
  fi
  systemctl enable postgresql >/dev/null 2>&1 || true
  systemctl start postgresql >/dev/null 2>&1 || service postgresql start >/dev/null 2>&1 || true

  as_postgres() {
    if command -v sudo >/dev/null 2>&1; then
      sudo -u postgres "$@"
    else
      su postgres -s /bin/sh -c "$*"
    fi
  }

  cat > "$TMP_DIR/db-init.sql" <<'DBSQL'
SELECT 'CREATE ROLE ' || quote_ident(:'dbuser') || ' LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'dbuser')\\gexec
SELECT 'ALTER ROLE ' || quote_ident(:'dbuser') || ' WITH LOGIN PASSWORD ' || quote_literal(:'dbpass')\\gexec
SELECT 'CREATE DATABASE ' || quote_ident(:'dbname') || ' OWNER ' || quote_ident(:'dbuser')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'dbname')\\gexec
DBSQL

  as_postgres psql -v ON_ERROR_STOP=1 -d postgres -v dbuser="$DB_USER" -v dbpass="$DB_PASS" -v dbname="$DB_NAME" -f "$TMP_DIR/db-init.sql"
  echo "数据库角色与库已就绪：$DB_USER / $DB_NAME"

  export PGPASSWORD="$DB_PASS"
  HAS_USERS="$(psql -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" -tA -c "select to_regclass('public.users') is not null")"

  if [ "$REBUILD_SCHEMA" = "1" ]; then
    # ---------- 强制清库重建 ----------
    step "强制重建数据库 schema（DROP SCHEMA public CASCADE）"
    echo "!! 正在清空 $DB_NAME 的全部业务数据 !!"
    cat > "$TMP_DIR/rebuild.sql" <<'REBUILDSQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
ALTER SCHEMA public OWNER TO :"dbuser";
GRANT ALL ON SCHEMA public TO :"dbuser";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
REBUILDSQL
    as_postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -v dbuser="$DB_USER" -f "$TMP_DIR/rebuild.sql"
    echo "public schema 已重建，pg_trgm 扩展已恢复"

    step "重新应用 Database/schema.sql"
    psql -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "$BACKEND_DIR/Database/schema.sql"
    echo "Database/schema.sql 已应用"
    echo "默认超管已重新种入：makimath_root（初始密码见部署记录，请上线后立即修改）"
  elif [ "$HAS_USERS" != "t" ]; then
    step "初始化数据库表结构"
    cat > "$TMP_DIR/extension.sql" <<'EXTSQL'
CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXTSQL
    as_postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$TMP_DIR/extension.sql"
    psql -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "$BACKEND_DIR/Database/schema.sql"
    echo "Database/schema.sql 已应用"
  else
    echo "检测到业务表已存在，跳过 schema.sql（如需清库重建，请把 forceSchema 设为 DROP_AND_REBUILD）"
  fi
  unset PGPASSWORD
fi

# ---------- 7. 启动服务 ----------
step "重启后端服务（pm2: $PM2_NAME）"
cd "$BACKEND_DIR"
pm2 delete "$PM2_NAME" >/dev/null 2>&1 || true
pm2 start npm --name "$PM2_NAME" -- start
pm2 save >/dev/null 2>&1 || true
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

# ---------- 8. 健康检查 ----------
step "健康检查 http://127.0.0.1:$APP_PORT/health"
READY=0
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS "http://127.0.0.1:$APP_PORT/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$READY" != "1" ]; then
  echo "后端健康检查失败，最近日志如下：" >&2
  pm2 logs "$PM2_NAME" --lines 50 --nostream >&2 || true
  exit 1
fi

curl -fsS "http://127.0.0.1:$APP_PORT/health"
echo

rm -rf "$TMP_DIR"
echo "后端部署完成：$BACKEND_DIR"
`

  const deployResult = await ssh.execCommand(`bash -lc ${quote(deployScript)}`, {
    onStdout: (chunk) => process.stdout.write(chunk.toString()),
    onStderr: (chunk) => process.stderr.write(chunk.toString()),
  })

  if (deployResult.code !== 0) {
    throw new Error(deployResult.stderr || "远程后端部署失败")
  }

  console.log(`后端部署完成：${remoteBackendDir}`)
}

main()
  .catch((error) => {
    console.error("部署失败：", error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    ssh.dispose()
    if (localEnvTmp) {
      fs.rmSync(localEnvTmp, { force: true })
    }
  })
