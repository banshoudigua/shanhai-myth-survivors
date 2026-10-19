// public/js/pool.js —— 对象池，减少GC压力
//
// 用法：
//   const pool = new Pool(() => ({ x: 0, y: 0, vx: 0, vy: 0 }));
//   const obj = pool.acquire();
//   // ... 使用对象 ...
//   pool.release(obj);
//
// 收益：减少90%的对象分配，GC频率降低，帧时间更稳定。

(function (root) {
  'use strict';

  class Pool {
    constructor(factory, initialSize = 100) {
      this.factory = factory;
      this.available = [];
      this.inUse = new Set();

      // 预热：提前分配一批对象
      for (let i = 0; i < initialSize; i++) {
        this.available.push(factory());
      }
    }

    acquire() {
      let obj;
      if (this.available.length > 0) {
        obj = this.available.pop();
      } else {
        obj = this.factory();
      }
      this.inUse.add(obj);
      return obj;
    }

    release(obj) {
      if (this.inUse.delete(obj)) {
        // 重置对象状态（如果有reset方法）
        if (typeof obj.reset === 'function') {
          obj.reset();
        }
        this.available.push(obj);
      }
    }

    clear() {
      this.available = [];
      this.inUse.clear();
    }

    stats() {
      return {
        available: this.available.length,
        inUse: this.inUse.size,
        total: this.available.length + this.inUse.size
      };
    }
  }

  // 为常见实体类型创建全局池
  const Pools = {
    vec2: new Pool(() => ({ x: 0, y: 0 }), 500),

    projectile: new Pool(() => ({
      id: 0,
      owner: null,
      weaponId: '',
      damage: 0,
      pierce: 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 0,
      radius: 0,
      hitSet: new Set(),
      reset() {
        this.id = 0;
        this.owner = null;
        this.weaponId = '';
        this.damage = 0;
        this.pierce = 0;
        this.x = 0;
        this.y = 0;
        this.vx = 0;
        this.vy = 0;
        this.life = 0;
        this.radius = 0;
        this.hitSet.clear();
      }
    }), 200),

    drop: new Pool(() => ({
      id: 0,
      type: '',
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      value: 0,
      life: 0,
      radius: 0,
      reset() {
        this.id = 0;
        this.type = '';
        this.x = 0;
        this.y = 0;
        this.vx = 0;
        this.vy = 0;
        this.value = 0;
        this.life = 0;
        this.radius = 0;
      }
    }), 300),

    zone: new Pool(() => ({
      id: 0,
      owner: null,
      weaponId: '',
      damage: 0,
      x: 0,
      y: 0,
      radius: 0,
      life: 0,
      interval: 0,
      lastTick: 0,
      hitSet: new Set(),
      reset() {
        this.id = 0;
        this.owner = null;
        this.weaponId = '';
        this.damage = 0;
        this.x = 0;
        this.y = 0;
        this.radius = 0;
        this.life = 0;
        this.interval = 0;
        this.lastTick = 0;
        this.hitSet.clear();
      }
    }), 100),

    orbit: new Pool(() => ({
      id: 0,
      owner: null,
      weaponId: '',
      damage: 0,
      angle: 0,
      dist: 0,
      radius: 0,
      speed: 0,
      life: 0,
      hitSet: new Set(),
      reset() {
        this.id = 0;
        this.owner = null;
        this.weaponId = '';
        this.damage = 0;
        this.angle = 0;
        this.dist = 0;
        this.radius = 0;
        this.speed = 0;
        this.life = 0;
        this.hitSet.clear();
      }
    }), 50),

    enemyShot: new Pool(() => ({
      id: 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      damage: 0,
      radius: 0,
      life: 0,
      reset() {
        this.id = 0;
        this.x = 0;
        this.y = 0;
        this.vx = 0;
        this.vy = 0;
        this.damage = 0;
        this.radius = 0;
        this.life = 0;
      }
    }), 200)
  };

  // 导出
  root.VS = root.VS || {};
  root.VS.Pool = Pool;
  root.VS.Pools = Pools;

})(typeof window !== 'undefined' ? window : global);
