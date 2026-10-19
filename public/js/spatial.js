// public/js/spatial.js —— 空间分割网格，加速碰撞检测
//
// 从 O(n²) 暴力检测 → O(n log n) 网格查询
// 收益：1200怪物碰撞检测从144万次降到5000次左右
//
// 用法：
//   const grid = new SpatialGrid(3200, 2400, 300);
//   grid.insert(entity);
//   const nearby = grid.query(x, y, radius);
//   grid.clear();

(function (root) {
  'use strict';

  class SpatialGrid {
    constructor(width, height, cellSize = 300) {
      this.width = width;
      this.height = height;
      this.cellSize = cellSize;
      this.cols = Math.ceil(width / cellSize);
      this.rows = Math.ceil(height / cellSize);

      // cells[row][col] = Set<entity>
      this.cells = [];
      for (let i = 0; i < this.rows; i++) {
        this.cells[i] = [];
        for (let j = 0; j < this.cols; j++) {
          this.cells[i][j] = new Set();
        }
      }

      // 快速查找：entity -> Set<cell位置>（一个实体可能跨多个格子）
      this.entityCells = new Map();
    }

    // 获取实体所在的格子坐标
    getCellCoords(x, y, radius) {
      const minCol = Math.max(0, Math.floor((x - radius) / this.cellSize));
      const maxCol = Math.min(this.cols - 1, Math.floor((x + radius) / this.cellSize));
      const minRow = Math.max(0, Math.floor((y - radius) / this.cellSize));
      const maxRow = Math.min(this.rows - 1, Math.floor((y + radius) / this.cellSize));

      const coords = [];
      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          coords.push([r, c]);
        }
      }
      return coords;
    }

    insert(entity) {
      const coords = this.getCellCoords(entity.x, entity.y, entity.radius || 0);
      const cellSet = new Set();

      for (const [r, c] of coords) {
        this.cells[r][c].add(entity);
        cellSet.add(`${r},${c}`);
      }

      this.entityCells.set(entity, cellSet);
    }

    // 更新实体位置（重新分配格子）
    update(entity) {
      const oldCells = this.entityCells.get(entity);
      if (oldCells) {
        for (const key of oldCells) {
          const [r, c] = key.split(',').map(Number);
          this.cells[r][c].delete(entity);
        }
      }
      this.insert(entity);
    }

    remove(entity) {
      const cellSet = this.entityCells.get(entity);
      if (cellSet) {
        for (const key of cellSet) {
          const [r, c] = key.split(',').map(Number);
          this.cells[r][c].delete(entity);
        }
        this.entityCells.delete(entity);
      }
    }

    // 查询以 (x, y, radius) 为中心的邻近实体
    query(x, y, radius) {
      const coords = this.getCellCoords(x, y, radius);
      const result = new Set();

      for (const [r, c] of coords) {
        for (const entity of this.cells[r][c]) {
          result.add(entity);
        }
      }

      return Array.from(result);
    }

    // 查询矩形范围内的实体
    queryRect(x0, y0, x1, y1) {
      const minCol = Math.max(0, Math.floor(Math.min(x0, x1) / this.cellSize));
      const maxCol = Math.min(this.cols - 1, Math.floor(Math.max(x0, x1) / this.cellSize));
      const minRow = Math.max(0, Math.floor(Math.min(y0, y1) / this.cellSize));
      const maxRow = Math.min(this.rows - 1, Math.floor(Math.max(y0, y1) / this.cellSize));

      const result = new Set();
      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          for (const entity of this.cells[r][c]) {
            result.add(entity);
          }
        }
      }
      return Array.from(result);
    }

    clear() {
      for (let i = 0; i < this.rows; i++) {
        for (let j = 0; j < this.cols; j++) {
          this.cells[i][j].clear();
        }
      }
      this.entityCells.clear();
    }

    // 调试统计
    stats() {
      let totalEntities = 0;
      let filledCells = 0;
      for (let i = 0; i < this.rows; i++) {
        for (let j = 0; j < this.cols; j++) {
          if (this.cells[i][j].size > 0) {
            filledCells++;
            totalEntities += this.cells[i][j].size;
          }
        }
      }
      return {
        totalEntities,
        filledCells,
        totalCells: this.rows * this.cols,
        avgPerCell: Math.round(totalEntities / (filledCells || 1))
      };
    }
  }

  // 导出
  root.VS = root.VS || {};
  root.VS.SpatialGrid = SpatialGrid;

})(typeof window !== 'undefined' ? window : global);
