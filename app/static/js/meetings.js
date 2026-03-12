// 会议记录页面逻辑
let currentMeetingId = null;

document.addEventListener('DOMContentLoaded', () => {
    const backBtn = document.getElementById('back-btn');
    backBtn.href = '/';
    backBtn.textContent = '← 返回';

    loadMeetings();
    document.addEventListener('click', (e) => {
        const wrap = document.getElementById('export-wrap');
        if (wrap && !wrap.contains(e.target)) wrap.classList.remove('open');
    });
});

function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '0秒';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}时${m}分${s}秒`;
    if (m > 0) return `${m}分${s}秒`;
    return `${s}秒`;
}

function formatTime(isoStr) {
    if (!isoStr) return '-';
    const d = new Date(isoStr.endsWith('Z') ? isoStr : isoStr + 'Z');
    return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).replace(/\//g, '-');
}

function formatDirection(dir) {
    const map = { 'zh-en': '中→英', 'en-zh': '英→中', 'zh-ja': '中→日', 'ja-zh': '日→中', 'en-ja': '英→日', 'ja-en': '日→英' };
    return map[dir] || dir || '-';
}

async function loadMeetings() {
    try {
        const res = await fetch('/api/meetings');
        const meetings = await res.json();
        renderMeetingList(meetings);
    } catch (e) {
        document.getElementById('meeting-list').innerHTML = '<div class="empty-list">加载失败，请刷新重试</div>';
    }
}

function renderMeetingList(meetings) {
    const listEl = document.getElementById('meeting-list');
    document.getElementById('meeting-count').textContent = meetings.length;

    if (!meetings.length) {
        listEl.innerHTML = '<div class="empty-list">暂无会议记录<br>完成一次翻译会话后自动生成</div>';
        return;
    }

    listEl.innerHTML = meetings.map(m => {
        const statusLabel = m.status === 'recording' ? '录制中' : (m.has_transcript ? '已完成' : '无内容');
        const statusClass = m.status === 'recording' ? 'recording' : (m.has_transcript ? 'completed' : 'empty');
        const dirStr = [formatDirection(m.speak_direction), formatDirection(m.listen_direction)].filter(d => d !== '-').join(' / ') || '-';
        return `<div class="meeting-card ${currentMeetingId === m.id ? 'active' : ''}" onclick="showDetail(${m.id})" data-id="${m.id}">
            <span class="card-status ${statusClass}">${statusLabel}</span>
            <div class="card-title">${escHtml(m.title || '未命名会议')}</div>
            <div class="card-meta">
                <span>⏱ ${formatDuration(m.duration_seconds)}</span>
                <span>📅 ${formatTime(m.start_time)}</span>
                <span>🔀 ${dirStr}</span>
            </div>
        </div>`;
    }).join('');
}

async function showDetail(meetingId) {
    currentMeetingId = meetingId;
    document.querySelectorAll('.meeting-card').forEach(c => c.classList.toggle('active', parseInt(c.dataset.id) === meetingId));
    document.getElementById('detail-title').textContent = '加载中...';
    document.getElementById('toolbar-actions').style.display = 'none';
    document.getElementById('stat-bar').style.display = 'none';
    document.getElementById('transcript-area').innerHTML = '<div class="detail-empty"><div>加载中...</div></div>';

    try {
        const res = await fetch('/api/meetings/' + meetingId);
        if (!res.ok) throw new Error('加载失败');
        renderDetail(await res.json());
    } catch (e) {
        document.getElementById('transcript-area').innerHTML = '<div class="detail-empty"><div>加载失败，请重试</div></div>';
    }
}

function renderDetail(data) {
    const { meta, entries } = data;
    document.getElementById('detail-title').textContent = meta.title || '未命名会议';
    document.getElementById('toolbar-actions').style.display = 'flex';

    const speakOrig = entries.filter(e => e.channel === 'speak' && e.type === 'original');
    const listenOrig = entries.filter(e => e.channel === 'listen' && e.type === 'original');
    document.getElementById('stat-duration').textContent = formatDuration(meta.duration_seconds);
    document.getElementById('stat-speak').textContent = speakOrig.length;
    document.getElementById('stat-listen').textContent = listenOrig.length;
    document.getElementById('stat-direction').textContent =
        [formatDirection(meta.speak_direction), formatDirection(meta.listen_direction)].filter(d => d !== '-').join(' / ') || '-';
    document.getElementById('stat-bar').style.display = entries.length ? 'flex' : 'none';

    if (!entries.length) {
        document.getElementById('transcript-area').innerHTML =
            '<div class="detail-empty"><div class="detail-empty-icon">🎙️</div><div>' +
            (meta.status === 'recording' ? '会议录制中...' : '本次会议未识别到内容') + '</div></div>';
        return;
    }

    // 按通道分组，将连续句子合并为段落（静默超过 8 秒则分段）
    function buildParagraphs(channel) {
        const origs = entries.filter(e => e.channel === channel && e.type === 'original');
        const trans = entries.filter(e => e.channel === channel && e.type === 'translated');

        if (!origs.length) return [];

        const SPLIT_GAP_SEC = 8;
        const paragraphs = [];
        let curOrigTexts = [];
        let curTransTexts = [];
        let curStartTs = origs[0].timestamp;
        let lastTs = origs[0].timestamp;

        origs.forEach((orig, i) => {
            const tSec = orig.timestamp ? new Date(orig.timestamp).getTime() / 1000 : 0;
            const lastSec = lastTs ? new Date(lastTs).getTime() / 1000 : tSec;
            // 与上一句时间差超过阈值则分段
            if (curOrigTexts.length > 0 && tSec - lastSec > SPLIT_GAP_SEC) {
                paragraphs.push({ startTs: curStartTs, origTexts: curOrigTexts, transTexts: curTransTexts });
                curOrigTexts = [];
                curTransTexts = [];
                curStartTs = orig.timestamp;
            }
            curOrigTexts.push(orig.text);
            if (trans[i]) curTransTexts.push(trans[i].text);
            lastTs = orig.timestamp;
        });

        if (curOrigTexts.length) {
            paragraphs.push({ startTs: curStartTs, origTexts: curOrigTexts, transTexts: curTransTexts });
        }
        return paragraphs;
    }

    function renderParagraphs(paragraphs) {
        if (!paragraphs.length) return '<div style="color:var(--text-sub);font-size:12px;padding:20px 0;">无内容</div>';
        return paragraphs.map(p => {
            const ts = (p.startTs || '').replace('T', ' ').slice(0, 19);
            const origText = p.origTexts.join('');
            const transText = p.transTexts.join('');
            return '<div class="entry-group">' +
                '<div class="entry-ts">' + ts + '</div>' +
                '<div class="entry-original">' + escHtml(origText) + '</div>' +
                (transText ? '<div class="entry-translated">' + escHtml(transText) + '</div>' : '') +
                '</div>';
        }).join('');
    }

    document.getElementById('transcript-area').innerHTML =
        '<div class="transcript-columns">' +
        '<div class="transcript-col"><div class="col-header"><span class="col-dot speak"></span>我方发言 (' + formatDirection(meta.speak_direction) + ')</div>' +
        renderParagraphs(buildParagraphs('speak')) + '</div>' +
        '<div class="transcript-col"><div class="col-header"><span class="col-dot listen"></span>对方发言 (' + formatDirection(meta.listen_direction) + ')</div>' +
        renderParagraphs(buildParagraphs('listen')) + '</div>' +
        '</div>';
}

function toggleExportMenu() {
    document.getElementById('export-wrap').classList.toggle('open');
}

function exportMeeting(fmt) {
    if (!currentMeetingId) return;
    document.getElementById('export-wrap').classList.remove('open');
    window.location.href = '/api/meetings/' + currentMeetingId + '/export?format=' + fmt;
}

async function deleteMeeting() {
    if (!currentMeetingId) return;
    if (!confirm('确定删除这条会议记录？此操作不可恢复。')) return;
    try {
        const res = await fetch('/api/meetings/' + currentMeetingId, { method: 'DELETE' });
        if (!res.ok) throw new Error('删除失败');
        currentMeetingId = null;
        document.getElementById('detail-title').textContent = '请选择一条会议记录';
        document.getElementById('toolbar-actions').style.display = 'none';
        document.getElementById('stat-bar').style.display = 'none';
        document.getElementById('transcript-area').innerHTML =
            '<div class="detail-empty"><div class="detail-empty-icon">📋</div><div>从左侧选择一条会议记录查看详情</div></div>';
        await loadMeetings();
    } catch (e) {
        alert('删除失败，请重试');
    }
}

function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
