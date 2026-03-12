// ===========================================
// 术语管理页业务逻辑
// ===========================================
document.addEventListener('DOMContentLoaded', () => {
    const targetUserId = '';
    const appendQuery = (url) => url;

    // 返回按钮
    (function() {
        const btn = document.getElementById('back-btn');
        btn.textContent = "← 返回";
        btn.href = '/';
    })();

    // 导出逻辑
    document.getElementById('export-btn').onclick = async () => {
        const btn = document.getElementById('export-btn');
        const originalText = btn.innerText;
        btn.innerText = '导出中...';
        btn.disabled = true;

        try {
            const res = await fetch(appendQuery('/api/glossary/export'));
            if (!res.ok) throw new Error('导出失败');
            const csvText = await res.text();

            if (window.pywebview && window.pywebview.api && window.pywebview.api.save_file) {
                const success = await window.pywebview.api.save_file(csvText, `glossary_export_${new Date().toISOString().slice(0,10)}.csv`);
                if (success) alert('导出成功！');
            } else {
                const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `glossary_export_${new Date().toISOString().slice(0,10)}.csv`;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                a.remove();
            }
        } catch (e) {
            alert('导出失败，请重试');
            console.error(e);
        } finally {
            btn.innerText = originalText;
            btn.disabled = false;
        }
    };

    // DOM 引用
    const treeEl = document.getElementById('category-tree');
    const listEl = document.getElementById('term-list');
    const editorEl = document.getElementById('term-editor');
    
    let curCatId = null, isPublicCat = false, allCats = [];

    // 1. 加载分类
    async function loadCats() {
        try {
            const res = await fetch(appendQuery('/api/glossary/categories'));
            allCats = await res.json();
            
            const myCats = allCats.filter(c => !c.is_public);
            const pubCats = allCats.filter(c => c.is_public);
            
            let html = '';
            if(myCats.length) {
                html += `<div class="cat-group-title">我的分类</div>`;
                html += myCats.map(c => renderCatItem(c)).join('');
            }
            if(pubCats.length) {
                html += `<div class="cat-group-title" style="margin-top:10px;">公共推荐库</div>`;
                html += pubCats.map(c => renderCatItem(c, true)).join('');
            }
            treeEl.innerHTML = html || '<div class="placeholder">暂无分类</div>';
        } catch(e) { treeEl.innerHTML = '<div class="placeholder">加载失败</div>'; }
    }

    function renderCatItem(c, isPub=false, level=0) {
        let html = `<div class="cat-item ${isPub?'public':''}" style="padding-left:${20+level*15}px" onclick="selectCat(${c.id}, ${isPub}, this)">
            <span>${c.name}</span>
            ${!isPub ? `<span class="cat-del-btn" onclick="delCat(event, ${c.id})">删除</span>` : ''}
        </div>`;
        if(c.children) html += c.children.map(child => renderCatItem(child, isPub, level+1)).join('');
        return html;
    }

    window.selectCat = async (id, isPub, el) => {
        curCatId = id; isPublicCat = isPub;
        document.querySelectorAll('.cat-item').forEach(e => e.classList.remove('selected'));
        el.classList.add('selected');
        document.getElementById('add-term-btn').style.display = isPub ? 'none' : 'block';
        document.getElementById('delete-selected-btn').style.display = 'none';
        await loadTerms(id);
        editorEl.innerHTML = '<div class="placeholder">请选择术语进行编辑</div>';
    };

    window.delCat = async (e, id) => {
        e.stopPropagation();
        if(!confirm('确定删除此分类及其术语吗？')) return;
        await fetch(appendQuery(`/api/glossary/categories/${id}`), {method:'DELETE'});
        loadCats();
    };

    // 2. 加载术语
    async function loadTerms(catId) {
        listEl.innerHTML = '<div class="placeholder">加载中...</div>';
        const res = await fetch(appendQuery(`/api/glossary/terms?category_id=${catId}`));
        const terms = await res.json();
        
        if(!terms.length) { listEl.innerHTML = '<div class="placeholder">暂无术语</div>'; return; }
        
        listEl.innerHTML = terms.map(t => `
            <div class="term-item" onclick="editTerm(${t.id}, this)">
                ${!isPublicCat ? `<input type="checkbox" class="term-check" data-id="${t.id}" onclick="event.stopPropagation();updateBulkBtn()">` : ''}
                <div class="term-content">
                    <div class="term-zh">${t.source}</div>
                    <div class="term-en">${t.target}</div>
                </div>
            </div>
        `).join('');
    }

    window.updateBulkBtn = () => {
        const n = document.querySelectorAll('.term-check:checked').length;
        document.getElementById('delete-selected-btn').style.display = n > 0 ? 'block' : 'none';
    };

    // 3. 编辑器
    window.editTerm = (id, el) => {
        document.querySelectorAll('.term-item').forEach(e => e.classList.remove('selected'));
        if(el) el.classList.add('selected');
        const src = el.querySelector('.term-zh').innerText;
        const tgt = el.querySelector('.term-en').innerText;
        renderEditor(id, src, tgt, ''); 
    };

    function renderEditor(id, src, tgt, notes) {
        const isNew = !id;
        const readOnly = isPublicCat && !isNew;
        
        editorEl.innerHTML = `
            <div class="editor-container">
                ${readOnly ? '<div style="background:rgba(16,185,129,0.1); color:#10b981; padding:10px; border-radius:6px; margin-bottom:20px; font-size:12px; border:1px solid rgba(16,185,129,0.2);">🔒 公共术语不可修改</div>' : ''}
                <div class="form-group">
                    <label class="form-label">原文 (Source)</label>
                    <input type="text" id="edit-src" class="form-input" value="${src||''}" ${readOnly?'disabled':''}>
                </div>
                <div class="form-group">
                    <label class="form-label">译文 (Target)</label>
                    <input type="text" id="edit-tgt" class="form-input" value="${tgt||''}" ${readOnly?'disabled':''}>
                </div>
                <div class="form-group">
                    <label class="form-label">备注 (Notes)</label>
                    <textarea id="edit-notes" class="form-input" style="height:100px" ${readOnly?'disabled':''}>${notes||''}</textarea>
                </div>
                ${!readOnly ? `
                <div style="display:flex; justify-content:space-between; margin-top:30px;">
                    ${!isNew ? `<button class="btn-danger-outline" onclick="deleteTerm(${id})">删除</button>` : '<div></div>'}
                    <button class="btn-primary" onclick="saveTerm(${id})">${isNew?'创建':'保存'}</button>
                </div>` : ''}
            </div>
        `;
    }

    // 功能逻辑
    document.getElementById('add-category-btn').onclick = async () => {
        const name = prompt("输入新分类名称:");
        if(name) {
            await fetch(appendQuery('/api/glossary/categories'), {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({name})
            });
            loadCats();
        }
    };

    document.getElementById('add-term-btn').onclick = () => {
        if(!curCatId) return alert('请先选择分类');
        if(isPublicCat) return alert('公共库不可添加');
        renderEditor(null);
    };

    window.saveTerm = async (id) => {
        const src = document.getElementById('edit-src').value;
        const tgt = document.getElementById('edit-tgt').value;
        if(!src || !tgt) return alert('请填写完整');
        const url = id ? `/api/glossary/terms/${id}` : '/api/glossary/terms';
        const method = id ? 'PUT' : 'POST';
        await fetch(appendQuery(url), {
            method, headers:{'Content-Type':'application/json'},
            body:JSON.stringify({source:src, target:tgt, category_id:curCatId})
        });
        loadTerms(curCatId);
        if(!id) renderEditor(null);
    };

    window.deleteTerm = async (id) => {
        if(!confirm('删除此术语?')) return;
        await fetch(appendQuery(`/api/glossary/terms/${id}`), {method:'DELETE'});
        loadTerms(curCatId);
        editorEl.innerHTML = '<div class="placeholder">已删除</div>';
    };

    // 导入逻辑
    document.getElementById('import-btn').onclick = () => {
        const sel = document.getElementById('import-category-select');
        sel.innerHTML = allCats.filter(c=>!c.is_public).map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
        document.getElementById('import-modal').style.display = 'flex';
    };
    
    document.getElementById('confirm-import-btn').onclick = async () => {
        const f = document.getElementById('import-file-input').files[0];
        const cid = document.getElementById('import-category-select').value;
        if(!f || !cid) return;
        const fd = new FormData(); fd.append('file', f); fd.append('category_id', cid);
        const res = await fetch(appendQuery('/api/glossary/import'), {method:'POST', body:fd});
        if(res.ok) {
            alert('导入成功');
            document.getElementById('import-modal').style.display = 'none';
            if(curCatId == cid) loadTerms(cid);
        } else alert('导入失败');
    };

    // 冲突检查
    document.getElementById('check-conflicts-btn').onclick = async () => {
        const res = await fetch(appendQuery('/api/glossary/conflicts'));
        const list = await res.json();
        const box = document.getElementById('conflict-list');
        box.innerHTML = list.length ? list.map((c, i) => `
            <div style="margin-bottom:15px; border-bottom:1px dashed var(--border); padding-bottom:10px;">
                <div style="font-weight:bold; color:var(--text-main); margin-bottom:5px;">${c.source}</div>
                ${c.translations.map((t, ti) => `
                    <label style="display:block; margin-bottom:3px; color:var(--text-sub); cursor:pointer;">
                        <input type="radio" name="cf-${i}" value="${t}" ${ti===0?'checked':''}> ${t}
                    </label>
                `).join('')}
            </div>
        `).join('') : '<div style="text-align:center; padding:20px; color:var(--text-sub);">暂无冲突</div>';
        document.getElementById('conflict-modal').style.display = 'flex';
    };

    loadCats();
});
