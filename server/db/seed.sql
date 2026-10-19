-- server/db/seed.sql
-- 初始化数值配置与成就定义（幂等：重复执行不会产生重复数据）

-- ============ 数值配置（后台可热更，改完不用重启） ============
INSERT INTO game_config (key, value, remark) VALUES
  ('match_duration_sec',   '1200',  '单局时长（秒），默认 20 分钟'),
  ('max_mobs',             '1200',  '同屏怪物硬上限，保护客户端帧率'),
  ('tick_rate',            '20',    '服务器权威循环频率（Hz）'),
  ('player_base_speed',    '120',   '玩家基础移速 px/s'),
  ('exp_curve_base',       '5',     '升级经验公式基数'),
  ('exp_curve_step',       '8',     '升级经验公式每级增量'),
  ('wave_interval_sec',    '30',    '每波间隔秒数'),
  ('mob_count_base',       '8',     '首波怪物基数'),
  ('mob_count_per_wave',   '4',     '每波怪物增量'),
  ('mob_count_cap',        '200',   '单波怪物数量上限'),
  ('mob_hp_growth',        '0.18',  '每波怪物血量增长系数'),
  ('elite_every_waves',    '3',     '每 N 波出现一次精英'),
  ('boss_every_waves',     '10',    '每 N 波出现一次 Boss'),
  ('weapon_slots',         '6',     '主动武器栏位'),
  ('passive_slots',        '6',     '被动道具栏位'),
  ('pickup_radius',        '40',    '经验球基础拾取半径 px'),
  ('rescue_channel_sec',   '3',     '救起濒死队友所需读条秒数'),
  ('map_width',            '3200',  '地图宽度 px'),
  ('map_height',           '2400',  '地图高度 px')
ON CONFLICT (key) DO NOTHING;

-- ============ 成就定义 ============
INSERT INTO achievements (code, name, descr, icon) VALUES
  ('first_blood',   '初尝血味',   '完成第一次击杀',               'ach_first'),
  ('survive_10min', '熬过一刻',   '单局存活满 10 分钟',           'ach_10min'),
  ('survive_20min', '长夜漫漫',   '单局存活满 20 分钟',           'ach_20min'),
  ('kills_500',     '屠戮者',     '单局击杀达到 500',             'ach_500'),
  ('kills_1000',    '血海滔天',   '单局击杀达到 1000',            'ach_1000'),
  ('level_50',      '登峰造极',   '单局等级达到 50',              'ach_lv50'),
  ('boss_slayer',   '弑月者',     '击杀一只血月领主',             'ach_boss'),
  ('team_cleared',  '全员生还',   '团队撑过全部波次并通关',        'ach_win'),
  ('no_death_win',  '毫发无伤',   '通关且全队无人阵亡',           'ach_nodeath'),
  ('rescuer',       '守护者',     '救起过 3 次濒死队友',          'ach_rescue')
ON CONFLICT (code) DO NOTHING;
