// 控制加密导入请求的大小
export const IMPORT_DATA_MAX = 32 * 1024 * 1024
export const IMPORT_BODY_MAX = Math.ceil((IMPORT_DATA_MAX + 65536 + 28) / 3) * 4 + 4096
