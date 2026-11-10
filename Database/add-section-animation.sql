-- 为现有数据库增加小节分步动画代码。
ALTER TABLE book_sections ADD COLUMN IF NOT EXISTS animation_source text NOT NULL DEFAULT '';
