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
  privateKeyPath:
    process.env.DEPLOY_PRIVATE_KEY_PATH ||
    fileConfig.privateKeyPath ||
    "",
  passphrase:
    process.env.DEPLOY_SSH_PASSPHRASE ||
    fileConfig.passphrase ||
    "",
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

if (
  !config.host ||
  !config.username ||
  (!config.privateKeyPath && !config.password) ||
  !config.remoteBaseDir
) {
  console.error(
    "部署配置不完整，请检查 host / username / privateKeyPath（或 password）/ remoteBaseDir。",
  )
  process.exit(1)
}

if (config.privateKeyPath && !fs.existsSync(config.privateKeyPath)) {
  console.error(`SSH 私钥文件不存在：${config.privateKeyPath}`)
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

  const merged = { ...config.env }

  if (config.setupDatabase) {
    Object.assign(merged, {
      PGHOST: "127.0.0.1",
      PGPORT: "5432",
      PGUSER: config.db.user,
      PGPASSWORD: config.db.password,
      PGDATABASE: config.db.name,
    })
  }

  return merged
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

  const sshOptions = {
    host: config.host,
    port: config.port,
    username: config.username,
    tryKeyboard: false,
  }

  if (config.privateKeyPath) {
    // node-ssh 需要私钥内容，而不是 .pub 公钥文件
    sshOptions.privateKey = fs.readFileSync(config.privateKeyPath, "utf8")

    if (config.passphrase) {
      sshOptions.passphrase = config.passphrase
    }
  } else {
    sshOptions.password = config.password
  }

  await ssh.connect(sshOptions)

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

if ! command -v dnf >/dev/null 2>&1; then
  echo "当前系统不支持本脚本的 dnf 安装流程，请检查操作系统。" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
  dnf install -y curl openssl ca-certificates
fi

if ! command -v node >/dev/null 2>&1 || \
   [ "$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)" -lt 22 ]; then
  curl -fsSL https://rpm.nodesource.com/setup_22.x -o "$TMP_DIR/nodesource-setup.sh"
  bash "$TMP_DIR/nodesource-setup.sh"
  dnf install -y nodejs
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 版本仍低于 22，请检查安装结果。" >&2
  exit 1
fi

echo "Node.js $(node -v)"

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

# 根据依赖文件哈希判断是否需要安装
DEPS_HASH_FILE="$BACKEND_DIR/.deps-hash"
CURRENT_DEPS_HASH=$(cat "$BACKEND_DIR/package.json" "$BACKEND_DIR/package-lock.json" | sha256sum | awk '{print $1}')
PREVIOUS_DEPS_HASH=$(cat "$DEPS_HASH_FILE" 2>/dev/null || true)

if [ ! -d "$BACKEND_DIR/node_modules" ] || [ "$CURRENT_DEPS_HASH" != "$PREVIOUS_DEPS_HASH" ]; then
  step "依赖发生变化，安装生产依赖"
  npm ci --omit=dev --no-audit --no-fund
  echo "$CURRENT_DEPS_HASH" > "$DEPS_HASH_FILE"
else
  step "依赖未变化，跳过安装"
fi

# ---------- 6. PostgreSQL 17 ----------
if [ "$SETUP_DB" = "1" ]; then
  step "检查 PostgreSQL 17"

  PSQL="/usr/pgsql-17/bin/psql"
  PG_SERVICE="postgresql-17.service"

  if [ ! -x "$PSQL" ]; then
    echo "未找到 PostgreSQL 17 客户端：$PSQL" >&2
    exit 1
  fi

  if ! systemctl is-active --quiet "$PG_SERVICE"; then
    systemctl start "$PG_SERVICE"
  fi

  systemctl is-active --quiet "$PG_SERVICE" || {
    echo "PostgreSQL 17 未正常运行。" >&2
    exit 1
  }

  as_postgres() {
    if [ "$(id -u)" = "0" ]; then
      /usr/sbin/runuser -u postgres -- "$@"
    elif command -v sudo >/dev/null 2>&1; then
      sudo -n /usr/sbin/runuser -u postgres -- "$@"
    else
      echo "需要 root 或具备 sudo 权限的账号来初始化数据库。" >&2
      return 1
    fi
  }

  # 只创建缺失的角色和数据库；不删除现有数据。
  cat > "$TMP_DIR/db-init.sql" <<'DBSQL'
SELECT 'CREATE ROLE ' || quote_ident(:'dbuser') || ' LOGIN'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = :'dbuser'
)
\\gexec

SELECT 'ALTER ROLE ' || quote_ident(:'dbuser')
  || ' WITH LOGIN PASSWORD ' || quote_literal(:'dbpass')
\\gexec

SELECT 'CREATE DATABASE ' || quote_ident(:'dbname')
  || ' OWNER ' || quote_ident(:'dbuser')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = :'dbname'
)
\\gexec

DBSQL

  as_postgres "$PSQL" \
    -p 5432 -d postgres \
    -v ON_ERROR_STOP=1 \
    -v dbuser="$DB_USER" \
    -v dbpass="$DB_PASS" \
    -v dbname="$DB_NAME" \
    -f "$TMP_DIR/db-init.sql"

  echo "数据库角色与数据库已检查：$DB_USER / $DB_NAME"

  # 后续业务连接统一走本机 TCP + 密码认证。
  export PGPASSWORD="$DB_PASS"

  DB_TABLE_COUNT="$(
    "$PSQL" -h 127.0.0.1 -p 5432 \
      -U "$DB_USER" -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 -tA \
      -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"
  )"

  HAS_USERS="$(
    "$PSQL" -h 127.0.0.1 -p 5432 \
      -U "$DB_USER" -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 -tA \
      -c "SELECT to_regclass('public.users') IS NOT NULL"
  )"

  if [ "$REBUILD_SCHEMA" = "1" ]; then
    if [ "$DB_NAME" != "maki_math_v2" ]; then
      echo "安全保护：清库重建只允许用于 maki_math_v2。" >&2
      exit 1
    fi

    step "重建新数据库 schema"
    echo "警告：即将清空 $DB_NAME 的 public schema。"

    cat > "$TMP_DIR/rebuild.sql" <<'REBUILDSQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
ALTER SCHEMA public OWNER TO :"dbuser";
GRANT ALL ON SCHEMA public TO :"dbuser";
REBUILDSQL

    as_postgres "$PSQL" \
      -p 5432 -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 \
      -v dbuser="$DB_USER" \
      -f "$TMP_DIR/rebuild.sql"

    as_postgres "$PSQL" \
      -p 5432 -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 \
      -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm'

    "$PSQL" -h 127.0.0.1 -p 5432 \
      -U "$DB_USER" -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 \
      -f "$BACKEND_DIR/Database/schema.sql"

    # 初始化增量迁移记录表并将当前已有迁移标记为已执行
    "$PSQL" -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c "
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        name text PRIMARY KEY,
        executed_at timestamptz NOT NULL DEFAULT now()
      );
    "
    if [ -d "$BACKEND_DIR/Database/migrations" ]; then
      for mig_file in "$BACKEND_DIR/Database/migrations"/*.sql; do
        [ -f "$mig_file" ] || continue
        mig_name=$(basename "$mig_file")
        "$PSQL" -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c "
          INSERT INTO _schema_migrations (name) VALUES ('$mig_name') ON CONFLICT (name) DO NOTHING;
        "
      done
    fi

  elif [ "$DB_TABLE_COUNT" = "0" ]; then
    step "初始化空数据库"

    as_postgres "$PSQL" \
      -p 5432 -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 \
      -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm'

    "$PSQL" -h 127.0.0.1 -p 5432 \
      -U "$DB_USER" -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 \
      -f "$BACKEND_DIR/Database/schema.sql"

    # 初始化增量迁移记录表并将当前已有迁移标记为已执行
    "$PSQL" -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c "
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        name text PRIMARY KEY,
        executed_at timestamptz NOT NULL DEFAULT now()
      );
    "
    if [ -d "$BACKEND_DIR/Database/migrations" ]; then
      for mig_file in "$BACKEND_DIR/Database/migrations"/*.sql; do
        [ -f "$mig_file" ] || continue
        mig_name=$(basename "$mig_file")
        "$PSQL" -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c "
          INSERT INTO _schema_migrations (name) VALUES ('$mig_name') ON CONFLICT (name) DO NOTHING;
        "
      done
    fi

  elif [ "$HAS_USERS" = "t" ]; then
    step "检测并应用增量数据库迁移"
    echo "检测到已有业务表和 public.users，跳过全量初始化，执行增量迁移检测..."

    # 确保迁移记录表存在
    "$PSQL" -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c "
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        name text PRIMARY KEY,
        executed_at timestamptz NOT NULL DEFAULT now()
      );
    "

    MIG_COUNT=0
    if [ -d "$BACKEND_DIR/Database/migrations" ]; then
      for mig_file in $(ls -1 "$BACKEND_DIR/Database/migrations"/*.sql 2>/dev/null | sort); do
        [ -f "$mig_file" ] || continue
        mig_name=$(basename "$mig_file")
        mig_applied=$("$PSQL" -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" -tA -c "
          SELECT count(*) FROM _schema_migrations WHERE name = '$mig_name';
        ")
        if [ "$mig_applied" = "0" ]; then
          echo "--> [执行迁移] $mig_name"
          "$PSQL" -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "$mig_file"
          "$PSQL" -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c "
            INSERT INTO _schema_migrations (name) VALUES ('$mig_name');
          "
          echo "--> [迁移成功] $mig_name"
          MIG_COUNT=$((MIG_COUNT + 1))
        else
          echo "增量迁移已就绪（跳过）: $mig_name"
        fi
      done
    fi

    if [ "$MIG_COUNT" -gt 0 ]; then
      echo "增量迁移执行完毕，共应用 $MIG_COUNT 个新迁移脚本。"
    else
      echo "数据库结构已是最新，无待执行迁移。"
    fi

  else
    echo "数据库已有 $DB_TABLE_COUNT 张 public 表，但缺少 public.users。" >&2
    echo "可能存在未完成的初始化。为避免数据损坏，停止部署，不自动重建。" >&2
    exit 1
  fi

  unset PGPASSWORD

  echo "数据库检查完成。"
fi

# ---------- 7. 启动服务 ----------
step "配置 systemd 后端服务"

SERVICE_NAME="maki-math-backend"

cat > "/tmp/$SERVICE_NAME.service" <<EOF
[Unit]
Description=MakiMath Backend V2
After=network.target postgresql-17.service
Wants=postgresql-17.service

[Service]
Type=simple
User=jason
WorkingDirectory=$BACKEND_DIR
Environment=NODE_ENV=production
Environment=PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/opt/node/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo install -m 644 "/tmp/$SERVICE_NAME.service" \
  "/etc/systemd/system/$SERVICE_NAME.service"

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

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
  sudo journalctl -u maki-math-backend-v2 -n 50 --no-pager >&2 || true
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
