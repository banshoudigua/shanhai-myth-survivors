// public/js/optimizations.js - 性能优化集成模块
//
// 整合对象池、空间索引、角色头像等优化
// 在game.js加载前执行，为游戏逻辑注入优化器

(function (root) {
  'use strict';

  // ============================================================
  // 性能监控（可视化面板）
  // ============================================================

  class PerformanceMonitor {
    constructor(enabled = false) {
      this.enabled = enabled;
      this.frameCount = 0;
      this.frameTime = 0;
      this.lastFrameTime = performance.now();
      this.stats = {
        fps: 0,
        frameMs: 0,
        poolStats: {},
        gridStats: {},
        memoryMB: 0
      };
      this.panel = null;
      if (enabled) {
        this.createPanel();
      }
    }

    createPanel() {
      const panel = document.createElement('div');
      panel.className = 'perf-panel';
      panel.innerHTML = `
        <div class="perf-title">性能监控</div>
        <div class="perf-row">
          <span class="perf-label">FPS</span>
          <span class="perf-value" id="perf-fps">0</span>
        </div>
        <div class="perf-row">
          <span class="perf-label">帧时间</span>
          <span class="perf-value" id="perf-frame">0ms</span>
        </div>
        <div class="perf-row">
          <span class="perf-label">对象池</span>
          <span class="perf-value" id="perf-pool">0</span>
        </div>
        <div class="perf-row">
          <span class="perf-label">网格实体</span>
          <span class="perf-value" id="perf-grid">0</span>
        </div>
        <div class="perf-row">
          <span class="perf-label">内存</span>
          <span class="perf-value" id="perf-mem">0 MB</span>
        </div>
      `;
      document.body.appendChild(panel);
      this.panel = panel;
    }

    update(frameMs, world) {
      if (!this.enabled) return;

      const now = performance.now();
      const deltaTime = now - this.lastFrameTime;
      this.lastFrameTime = now;

      this.frameCount++;
      this.frameTime += deltaTime;

      if (this.frameTime >= 1000) {
        this.stats.fps = this.frameCount;
        this.frameCount = 0;
        this.frameTime -= 1000;
      }

      this.stats.frameMs = frameMs;

      // 更新面板显示
      if (this.panel) {
        document.getElementById('perf-fps').textContent = this.stats.fps;
        const frameClass = frameMs < 16 ? 'good' : frameMs < 33 ? 'warning' : 'bad';
        document.getElementById('perf-frame').className = `perf-value ${frameClass}`;
        document.getElementById('perf-frame').textContent = frameMs.toFixed(1) + 'ms';

        // 内存监控（仅Chrome支持）
        if (performance.memory) {
          this.stats.memoryMB = (performance.memory.usedJSHeapSize / 1048576).toFixed(1);
          document.getElementById('perf-mem').textContent = this.stats.memoryMB + ' MB';
        }
      }

      return this.stats;
    }
  }

  // ============================================================
  // 世界优化包装器
  // ============================================================

  class OptimizedWorldWrapper {
    constructor(world) {
      this.world = world;
      this.spatialGrid = new root.VS.SpatialGrid(3200, 2400, 300);
      this.lastUpdateTick = -1;
    }

    // 获取邻近实体（用于碰撞检测）
    getNearby(entity) {
      if (entity.radius === undefined) entity.radius = 40;
      return this.spatialGrid.query(entity.x, entity.y, entity.radius * 3);
    }

    // 更新空间索引
    updateSpatialIndex() {
      const curTick = this.world?.tick || 0;
      if (curTick === this.lastUpdateTick) return;
      this.lastUpdateTick = curTick;

      this.spatialGrid.clear();

      // 添加所有实体到网格
      if (this.world?.mobs) {
        for (const mob of this.world.mobs) {
          this.spatialGrid.insert(mob);
        }
      }

      if (this.world?.projectiles) {
        for (const proj of this.world.projectiles) {
          this.spatialGrid.insert(proj);
        }
      }

      if (this.world?.zones) {
        for (const zone of this.world.zones) {
          this.spatialGrid.insert(zone);
        }
      }
    }

    getStats() {
      return this.spatialGrid.stats();
    }
  }

  // ============================================================
  // 导出与初始化
  // ============================================================

  root.VS = root.VS || {};
  root.VS.PerformanceMonitor = PerformanceMonitor;
  root.VS.OptimizedWorldWrapper = OptimizedWorldWrapper;

  // 全局性能监控实例（通过URL参数 ?perf 启用）
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('perf')) {
    root.VS.perfMonitor = new PerformanceMonitor(true);
    console.log('[opt] 性能监控已启用，访问 ?perf=off 禁用');
  }

})(typeof window !== 'undefined' ? window : global);
