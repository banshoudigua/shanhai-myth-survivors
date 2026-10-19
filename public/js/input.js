// public/js/input.js —— 输入层：键盘 + 触屏虚拟摇杆
//
// 输出只有一个方向向量 { mx, my }（长度 0~1），交给 sim.step 用。
// 本游戏是自动攻击，玩家只需要控制移动，所以输入层保持极简。
//
// 支持三种操作方式：
//   1. 键盘 WASD / 方向键（桌面）
//   2. 触屏任意位置按下出现浮动摇杆（手机，拇指拖到哪走到哪）
//   3. 鼠标按住左键朝光标方向走（桌面调试方便）

(function (root) {
  'use strict';

  // 摇杆参数
  const JOY_MAX_RADIUS = 60;     // 拖到这个距离就是满速
  const JOY_DEAD_ZONE = 8;       // 死区，避免手指微抖就走

  function createInput(canvas) {
    const input = {
      mx: 0,
      my: 0,
      // 摇杆状态（渲染层会读它来画摇杆）
      joy: { active: false, ox: 0, oy: 0, cx: 0, cy: 0 },
      hasTouch: false,
      onPause: null,        // 外部注册：按下暂停键时调用
      onRestart: null
    };

    // 键盘按下的键集合
    const keys = Object.create(null);
    // 鼠标按住移动
    let mouseDown = false;
    let mouseX = 0;
    let mouseY = 0;
    // 触屏摇杆的 touch 标识（多指时只认第一根）
    let joyTouchId = null;

    // ============================================================
    // 键盘
    // ============================================================

    function onKeyDown(e) {
      const k = e.key;

      // 方向键与空格会滚动页面，必须拦掉
      if (k === ' ' || k.indexOf('Arrow') === 0) e.preventDefault();

      keys[k.toLowerCase()] = true;

      if (k === 'Escape' || k === 'p' || k === 'P') {
        if (input.onPause) input.onPause();
      }
      if (k === 'r' || k === 'R') {
        if (input.onRestart) input.onRestart();
      }
    }

    function onKeyUp(e) {
      keys[e.key.toLowerCase()] = false;
    }

    // 失焦时清空按键，避免切出去再回来人物一直往一个方向跑
    function onBlur() {
      const list = Object.keys(keys);
      for (let i = 0; i < list.length; i++) keys[list[i]] = false;
      mouseDown = false;
      joyTouchId = null;
      input.joy.active = false;
    }

    // ============================================================
    // 鼠标（按住朝光标走）
    // ============================================================

    function onMouseDown(e) {
      if (e.button !== 0) return;
      mouseDown = true;
      updateMousePos(e);
    }

    function onMouseMove(e) {
      updateMousePos(e);
    }

    function onMouseUp() {
      mouseDown = false;
    }

    function updateMousePos(e) {
      const rect = canvas.getBoundingClientRect();
      mouseX = e.clientX - rect.left;
      mouseY = e.clientY - rect.top;
    }

    // ============================================================
    // 触屏浮动摇杆
    // ============================================================

    function findTouch(e, id) {
      const list = e.changedTouches;
      for (let i = 0; i < list.length; i++) {
        if (list[i].identifier === id) return list[i];
      }
      return null;
    }

    function onTouchStart(e) {
      input.hasTouch = true;
      // 已经有摇杆在跟就不再接管，避免多指乱跳
      if (joyTouchId !== null) return;

      const t = e.changedTouches[0];
      if (!t) return;
      e.preventDefault();

      joyTouchId = t.identifier;
      const rect = canvas.getBoundingClientRect();
      const x = t.clientX - rect.left;
      const y = t.clientY - rect.top;

      input.joy.active = true;
      input.joy.ox = x;
      input.joy.oy = y;
      input.joy.cx = x;
      input.joy.cy = y;
    }

    function onTouchMove(e) {
      if (joyTouchId === null) return;
      const t = findTouch(e, joyTouchId);
      if (!t) return;
      e.preventDefault();

      const rect = canvas.getBoundingClientRect();
      let x = t.clientX - rect.left;
      let y = t.clientY - rect.top;

      // 摇杆头限制在最大半径内
      const dx = x - input.joy.ox;
      const dy = y - input.joy.oy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > JOY_MAX_RADIUS) {
        x = input.joy.ox + (dx / d) * JOY_MAX_RADIUS;
        y = input.joy.oy + (dy / d) * JOY_MAX_RADIUS;
      }

      input.joy.cx = x;
      input.joy.cy = y;
    }

    function onTouchEnd(e) {
      if (joyTouchId === null) return;
      const t = findTouch(e, joyTouchId);
      if (!t) return;

      joyTouchId = null;
      input.joy.active = false;
    }

    // ============================================================
    // 每帧解析成方向向量
    // ============================================================

    input.update = function () {
      let mx = 0;
      let my = 0;

      // 1) 键盘优先：按了方向键就按键盘走
      let kx = 0;
      let ky = 0;
      if (keys['a'] || keys['arrowleft']) kx -= 1;
      if (keys['d'] || keys['arrowright']) kx += 1;
      if (keys['w'] || keys['arrowup']) ky -= 1;
      if (keys['s'] || keys['arrowdown']) ky += 1;

      if (kx || ky) {
        // 斜向不能比直向快，归一化
        const d = Math.sqrt(kx * kx + ky * ky);
        mx = kx / d;
        my = ky / d;
      } else if (input.joy.active) {
        // 2) 触屏摇杆
        const dx = input.joy.cx - input.joy.ox;
        const dy = input.joy.cy - input.joy.oy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > JOY_DEAD_ZONE) {
          // 拖得越远越快，满半径时速度拉满
          const strength = Math.min(1, (d - JOY_DEAD_ZONE) / (JOY_MAX_RADIUS - JOY_DEAD_ZONE));
          mx = (dx / d) * strength;
          my = (dy / d) * strength;
        }
      } else if (mouseDown) {
        // 3) 鼠标按住：朝光标方向走，靠近光标 12px 内就停
        const dx = mouseX - canvas.width / 2;
        const dy = mouseY - canvas.height / 2;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > 12) {
          mx = dx / d;
          my = dy / d;
        }
      }

      input.mx = mx;
      input.my = my;
      return { mx: mx, my: my };
    };

    // ============================================================
    // 事件绑定与解绑
    // ============================================================

    input.attach = function () {
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', onBlur);

      canvas.addEventListener('mousedown', onMouseDown);
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);

      canvas.addEventListener('touchstart', onTouchStart, { passive: false });
      canvas.addEventListener('touchmove', onTouchMove, { passive: false });
      canvas.addEventListener('touchend', onTouchEnd);
      canvas.addEventListener('touchcancel', onTouchEnd);

      // 触屏设备上禁用长按选中与页面滚动造成的位移
      canvas.style.touchAction = 'none';
      canvas.style.userSelect = 'none';
    };

    input.detach = function () {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchEnd);
    };

    return input;
  }

  root.VS = root.VS || {};
  root.VS.createInput = createInput;
})(window);
