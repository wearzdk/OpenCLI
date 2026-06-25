import { cli, Strategy } from '@jackwener/opencli/registry';
/**
 * 转发即刻帖子
 *
 * 操作栏转发按钮点击后弹出 Popover 菜单，
 * 选择"转发动态"后弹出编辑器弹窗（可添加附言），
 * 再点击"发布"确认转发。
 */
cli({
    site: 'jike',
    name: 'repost',
    access: 'write',
    description: '转发即刻帖子',
    domain: 'web.okjike.com',
    strategy: Strategy.UI,
    browser: true,
    args: [
        { name: 'id', type: 'string', required: true, positional: true, help: '帖子 ID' },
        { name: 'text', positional: true, type: 'string', required: false, help: '转发附言（可选）' },
    ],
    columns: ['status', 'message'],
    func: async (page, kwargs) => {
        await page.goto(`https://web.okjike.com/originalPost/${kwargs.id}`);
        // 详情页 SPA 异步 hydrate，操作栏一次性 querySelector 会和渲染竞速，慢渲染下
        // 误报"未找到操作栏/转发按钮"。改为有界轮询等待操作栏的第三个可见子元素出现，
        // 再走原有的一次性点击逻辑（选择器/控制流不变）。
        for (let i = 0; i < 30; i++) {
            const ready = await page.evaluate(`(() => {
        const actions = document.querySelector('[class*="_actions_"]');
        if (!actions) return false;
        const children = Array.from(actions.children).filter(c => c.offsetHeight > 0);
        return !!children[2];
      })()`);
            if (ready)
                break;
            await page.wait(0.5);
        }
        // 1. 点击操作栏中的转发按钮（第三个子元素）
        const clickResult = await page.evaluate(`(async () => {
      try {
        const actions = document.querySelector('[class*="_actions_"]');
        if (!actions) return { ok: false, message: '未找到操作栏' };
        const children = Array.from(actions.children).filter(c => c.offsetHeight > 0);
        if (!children[2]) return { ok: false, message: '未找到转发按钮' };
        // 注意：按位置定位，即刻操作栏顺序变化时需调整
        children[2].click();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: e.toString() };
      }
    })()`);
        if (!clickResult.ok) {
            return [{ status: 'failed', message: clickResult.message }];
        }
        await page.wait(1);
        // 转发 Popover 菜单异步弹出，一次性查找"转发动态"会和动画/渲染竞速。改为有界
        // 轮询等待菜单项出现，再走原有的一次性点击逻辑（选择器/控制流不变）。
        for (let i = 0; i < 30; i++) {
            const ready = await page.evaluate(`(() => {
        return Array.from(document.querySelectorAll('button')).some(
          b => b.textContent?.trim() === '转发动态'
        );
      })()`);
            if (ready)
                break;
            await page.wait(0.5);
        }
        // 2. 在弹出菜单中点击"转发动态"
        const menuResult = await page.evaluate(`(async () => {
      try {
        const btn = Array.from(document.querySelectorAll('button')).find(
          b => b.textContent?.trim() === '转发动态'
        );
        if (!btn) return { ok: false, message: '未找到"转发动态"菜单项' };
        btn.click();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: e.toString() };
      }
    })()`);
        if (!menuResult.ok) {
            return [{ status: 'failed', message: menuResult.message }];
        }
        await page.wait(2);
        // 3. 若有附言，在弹窗编辑器中填入
        if (kwargs.text) {
            // 转发编辑器弹窗异步渲染，一次性查找 contenteditable 会和弹窗渲染竞速，
            // 慢渲染下误报"未找到附言输入框"。改为有界轮询等待编辑器出现，再走原有的
            // 一次性写入逻辑（选择器/控制流不变）。
            for (let i = 0; i < 30; i++) {
                const ready = await page.evaluate(`(() => {
          return !!document.querySelector('[contenteditable="true"]');
        })()`);
                if (ready)
                    break;
                await page.wait(0.5);
            }
            const textResult = await page.evaluate(`(async () => {
        try {
          const textToInsert = ${JSON.stringify(kwargs.text)};
          const editor = document.querySelector('[contenteditable="true"]');
          if (!editor) return { ok: false, message: '未找到附言输入框' };
          editor.focus();
          const dt = new DataTransfer();
          dt.setData('text/plain', textToInsert);
          editor.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dt, bubbles: true, cancelable: true,
          }));
          await new Promise(r => setTimeout(r, 500));
          return { ok: true };
        } catch(e) { return { ok: false, message: '附言写入失败: ' + e.toString() }; }
      })()`);
            if (!textResult.ok) {
                return [{ status: 'failed', message: textResult.message }];
            }
        }
        // 转发弹窗的"发送/发布"按钮在内容就绪后才可用，一次性探测会和状态切换竞速。
        // 改为有界轮询等待可用确认按钮出现，再走原有的一次性点击逻辑（选择器/控制流不变）。
        for (let i = 0; i < 30; i++) {
            const ready = await page.evaluate(`(() => {
        return Array.from(document.querySelectorAll('button')).some(b => {
          const text = b.textContent?.trim() || '';
          return (text === '发送' || text === '发布') && !b.disabled;
        });
      })()`);
            if (ready)
                break;
            await page.wait(0.5);
        }
        // 4. 点击"发送"按钮确认转发
        const confirmResult = await page.evaluate(`(async () => {
      try {
        await new Promise(r => setTimeout(r, 500));
        const btn = Array.from(document.querySelectorAll('button')).find(b => {
          const text = b.textContent?.trim() || '';
          // 不匹配"转发动态"，避免重复触发 Popover 菜单项
          return (text === '发送' || text === '发布') && !b.disabled;
        });
        if (!btn) return { ok: false, message: '未找到发送按钮' };
        btn.click();
        return { ok: true, message: '转发成功' };
      } catch (e) {
        return { ok: false, message: e.toString() };
      }
    })()`);
        if (confirmResult.ok)
            await page.wait(3);
        return [{
                status: confirmResult.ok ? 'success' : 'failed',
                message: confirmResult.message,
            }];
    },
});
