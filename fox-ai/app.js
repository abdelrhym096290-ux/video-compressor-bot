// ============================================
// FOX AI - منطق الواجهة
// ============================================

// الحالة
let currentChatId = null;
let chats = [];
let theme = localStorage.getItem('fox-theme') || 'auto';

// عناصر DOM
const messagesEl = document.getElementById('messages');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const chatList = document.getElementById('chat-list');
const newChatBtn = document.getElementById('new-chat');
const menuBtn = document.getElementById('menu-btn');
const closeSidebarBtn = document.getElementById('close-sidebar');
const sidebar = document.getElementById('sidebar');
const clearChatBtn = document.getElementById('clear-chat');
const themeToggle = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');
const themeText = document.getElementById('theme-text');

// تطبيق المظهر
function applyTheme(theme) {
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
    themeIcon.textContent = '🌗';
    themeText.textContent = 'تلقائي';
  } else if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    themeIcon.textContent = '🌙';
    themeText.textContent = 'داكن';
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
    themeIcon.textContent = '☀️';
    themeText.textContent = 'فاتح';
  }
  localStorage.setItem('fox-theme', theme);
}

// تبديل المظهر
themeToggle.addEventListener('click', () => {
  if (theme === 'auto') theme = 'dark';
  else if (theme === 'dark') theme = 'light';
  else theme = 'auto';
  applyTheme(theme);
});

// فتح/إغلاق القائمة
menuBtn.addEventListener('click', () => {
  sidebar.classList.toggle('visible');
  sidebar.classList.toggle('hidden');
});

closeSidebarBtn.addEventListener('click', () => {
  sidebar.classList.add('hidden');
  sidebar.classList.remove('visible');
});

// محادثة جديدة
newChatBtn.addEventListener('click', () => {
  createNewChat();
});

// مسح المحادثة
clearChatBtn.addEventListener('click', () => {
  if (currentChatId) {
    const chat = chats.find(c => c.id === currentChatId);
    if (chat) {
      chat.messages = [];
      renderMessages();
      saveChats();
    }
  }
});

// إنشاء محادثة جديدة
function createNewChat() {
  const chat = {
    id: Date.now().toString(),
    title: 'محادثة جديدة',
    messages: [],
    createdAt: new Date().toISOString()
  };
  chats.unshift(chat);
  currentChatId = chat.id;
  renderChatList();
  renderMessages();
  saveChats();
  sidebar.classList.add('hidden');
}

// إرسال رسالة
async function sendMessage() {
  const text = userInput.value.trim();
  if (!text) return;
  
  if (!currentChatId) {
    createNewChat();
  }
  
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat) return;
  
  // إضافة رسالة المستخدم
  chat.messages.push({ role: 'user', content: text });
  userInput.value = '';
  renderMessages();
  saveChats();
  
  // تحديث عنوان المحادثة
  if (chat.messages.length === 1) {
    chat.title = text.substring(0, 30);
    renderChatList();
    saveChats();
  }
  
  // تعطيل الإرسال
  sendBtn.disabled = true;
  
  // إضافة رسالة انتظار
  const loadingMsg = { role: 'ai', content: '...', loading: true };
  chat.messages.push(loadingMsg);
  renderMessages();
  
  try {
    // هنا سيتم الاتصال بـ Cloudflare Worker
    const response = await callFoxAI(chat.messages.filter(m => !m.loading));
    chat.messages.pop(); // إزالة رسالة الانتظار
    chat.messages.push({ role: 'ai', content: response });
  } catch (error) {
    chat.messages.pop();
    chat.messages.push({ role: 'ai', content: 'عذرًا، حدث خطأ: ' + error.message });
  }
  
  renderMessages();
  saveChats();
  sendBtn.disabled = false;
}

// الاتصال بـ FOX AI
async function callFoxAI(messages) {
  // سيتم تعديل هذا ليتصل بـ Cloudflare Worker
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages })
  });
  
  if (!response.ok) {
    throw new Error('فشل الاتصال');
  }
  
  const data = await response.json();
  return data.response;
}

// عرض الرسائل
function renderMessages() {
  messagesEl.innerHTML = '';
  
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat || chat.messages.length === 0) {
    // رسالة ترحيب
    const welcome = document.createElement('div');
    welcome.className = 'message ai';
    welcome.innerHTML = `
      <div class="message-avatar">🦊</div>
      <div class="message-content">مرحبًا! أنا FOX AI. كيف يمكنني مساعدتك؟</div>
    `;
    messagesEl.appendChild(welcome);
    return;
  }
  
  chat.messages.forEach(msg => {
    const div = document.createElement('div');
    div.className = `message ${msg.role}`;
    
    const avatar = msg.role === 'user' ? '👤' : '🦊';
    const content = msg.loading ? '<span class="typing">...</span>' : msg.content;
    
    div.innerHTML = `
      <div class="message-avatar">${avatar}</div>
      <div class="message-content">${content}</div>
    `;
    messagesEl.appendChild(div);
  });
  
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// عرض قائمة المحادثات
function renderChatList() {
  chatList.innerHTML = '';
  
  chats.forEach(chat => {
    const div = document.createElement('div');
    div.className = `chat-item ${chat.id === currentChatId ? 'active' : ''}`;
    div.textContent = chat.title;
    div.addEventListener('click', () => {
      currentChatId = chat.id;
      renderChatList();
      renderMessages();
      sidebar.classList.add('hidden');
    });
    chatList.appendChild(div);
  });
}

// حفظ المحادثات
function saveChats() {
  localStorage.setItem('fox-chats', JSON.stringify(chats));
}

// تحميل المحادثات
function loadChats() {
  const saved = localStorage.getItem('fox-chats');
  if (saved) {
    chats = JSON.parse(saved);
    renderChatList();
    if (chats.length > 0) {
      currentChatId = chats[0].id;
      renderMessages();
    }
  }
}

// أحداث
sendBtn.addEventListener('click', sendMessage);

userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// تهيئة
applyTheme(theme);
loadChats();