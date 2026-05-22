const ADMIN_CODE = "DNH-SAT-ADMIN";
const META_KEY = "dhSatThreeModeMeta";
const DB_NAME = "dhSatThreeModeFiles";
const DB_VERSION = 1;
const LOGO_CANDIDATES = [
  "https://dnhcollege.com/wp-content/uploads/2023/12/cropped-DH-College-logo.png",
  "https://dnhcollege.com/wp-content/uploads/2024/01/cropped-DH-College-logo.png",
  "https://dnhcollege.com/wp-content/uploads/2023/12/DH-College-logo.png",
  "https://dnhcollege.com/wp-content/uploads/2024/01/DH-College-logo.png",
  "https://www.google.com/s2/favicons?domain=dnhcollege.com&sz=128"
];

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

let db;
let extractedQuestions = [];
let extractedModules = [];

let state = {
  users: [],
  tests: [],
  attempts: [],
  currentUser: null,
  activeTest: null,
  activeMode: "full",
  activeModules: [],
  activeAttempt: null,
  currentModuleIndex: 0,
  currentQuestionIndex: 0,
  moduleStartedAt: null,
  timerInterval: null,
  pdfUrl: null
};

function uid(){return `${Date.now()}-${Math.random().toString(16).slice(2)}`;}
function todayISO(){return new Date().toISOString().slice(0,10);}
function escapeHtml(str){return String(str??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
function normalizeAnswer(a){return String(a??"").trim().toUpperCase();}
function toast(msg){const el=document.getElementById("toast");el.textContent=msg;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),3000);}
async function sha(text){const data=new TextEncoder().encode(text);const hash=await crypto.subtle.digest("SHA-256",data);return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");}

function setupLogo(img){
  let i = 0;
  function tryNext(){ if (i < LOGO_CANDIDATES.length) img.src = LOGO_CANDIDATES[i++]; }
  img.onerror = tryNext;
  tryNext();
}

function modeLabel(mode){
  if (mode === "english") return "English Only";
  if (mode === "math") return "Math Only";
  return "Full Test";
}

function modeScoreLabel(mode){
  if (mode === "english") return "English";
  if (mode === "math") return "Math";
  return "Full";
}

function openDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=e=>{const d=e.target.result;if(!d.objectStoreNames.contains("files"))d.createObjectStore("files",{keyPath:"id"});};req.onsuccess=e=>resolve(e.target.result);req.onerror=()=>reject(req.error);});}
function saveFile(id,blob,filename,type){return new Promise((resolve,reject)=>{const tx=db.transaction("files","readwrite");tx.objectStore("files").put({id,blob,filename,type,savedAt:new Date().toISOString()});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
function getFile(id){return new Promise((resolve,reject)=>{const tx=db.transaction("files","readonly");const req=tx.objectStore("files").get(id);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function deleteFile(id){return new Promise((resolve,reject)=>{const tx=db.transaction("files","readwrite");tx.objectStore("files").delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}

function loadMeta(){try{return JSON.parse(localStorage.getItem(META_KEY))||{users:[],tests:[],attempts:[]};}catch{return {users:[],tests:[],attempts:[]};}}
function saveMeta(){localStorage.setItem(META_KEY,JSON.stringify({users:state.users,tests:state.tests,attempts:state.attempts,currentUserId:state.currentUser?.id||null}));}
function currentMetaUser(){return state.users.find(u=>u.id===state.currentUser?.id)||null;}
function isAdmin(){return currentMetaUser()?.role==="admin";}

function renderAuthState(){
  const logged = !!state.currentUser;
  document.getElementById("auth-screen").classList.toggle("hidden", logged);
  document.getElementById("app-shell").classList.toggle("hidden", !logged);
  document.querySelectorAll(".admin-only").forEach(el=>el.classList.toggle("hidden", !isAdmin()));
  if (logged) showPage("dashboard");
}

function parseCSV(text){
  const rows=[];let current="",row=[],inside=false;
  for(let i=0;i<text.length;i++){
    const c=text[i], n=text[i+1];
    if(c === '"' && inside && n === '"'){current += '"'; i++;}
    else if(c === '"'){inside = !inside;}
    else if(c === "," && !inside){row.push(current.trim()); current="";}
    else if((c === "\n" || c === "\r") && !inside){
      if(current.length || row.length){row.push(current.trim()); rows.push(row); row=[]; current="";}
      if(c === "\r" && n === "\n") i++;
    } else current += c;
  }
  if(current.length || row.length){row.push(current.trim()); rows.push(row);}
  if(rows.length < 2) return [];
  const headers = rows[0].map(h=>h.trim());
  return rows.slice(1).filter(r=>r.some(c=>c !== "")).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]||""])));
}

function fileToText(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=reject;r.readAsText(file);});}
function fileToArrayBuffer(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsArrayBuffer(file);});}

function setStatus(text){document.getElementById("extract-status").textContent = text;}

async function extractPdfText(mode){
  const file = document.getElementById("pdf-file").files[0];
  if (!file) return toast("Choose a PDF first.");
  if (!window.pdfjsLib) return toast("PDF.js did not load. Check your internet connection.");

  extractedQuestions = [];
  extractedModules = [];
  renderExtractionPreview();

  try {
    setStatus("Loading PDF...");
    const buffer = await fileToArrayBuffer(file);
    const pdf = await pdfjsLib.getDocument({data: buffer}).promise;
    const pageTexts = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      setStatus(`Reading page ${i} of ${pdf.numPages}...`);

      const page = await pdf.getPage(i);
      let text = "";

      if (mode === "fast") {
        const content = await page.getTextContent();
        text = content.items.map(item => item.str).join("\n");
      }

      if (mode === "ocr" || text.replace(/\s/g, "").length < 80) {
        if (!window.Tesseract) return toast("Tesseract OCR did not load. Check your internet connection.");
        setStatus(`OCR page ${i} of ${pdf.numPages}. This is slower for scanned PDFs but only needed once.`);
        const viewport = page.getViewport({scale: 2.1});
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d", {willReadFrequently: true});
        await page.render({canvasContext: ctx, viewport}).promise;
        const result = await Tesseract.recognize(canvas, "eng", {
          logger: m => {
            if (m.status && m.progress) {
              setStatus(`OCR page ${i} of ${pdf.numPages}: ${m.status} ${Math.round(m.progress * 100)}%`);
            }
          }
        });
        text = result.data.text;
      }

      pageTexts.push({page: i, text});
    }

    const parsed = splitQuestions(pageTexts);
    extractedQuestions = parsed.questions;
    extractedModules = parsed.modules;
    renderExtractionPreview();
    setStatus(`Extraction complete: ${extractedQuestions.length} questions detected in ${extractedModules.length} module(s). English/Math/Full modes will be created automatically from the detected module sections.`);
  } catch (err) {
    console.error(err);
    setStatus("Extraction failed. Try OCR mode or use a cleaner PDF.");
    toast("Extraction failed.");
  }
}

function detectModule(line, currentModule){
  const clean = line.replace(/\s+/g, " ").trim();

  let match = clean.match(/Section\s+(\d+)\s*,?\s*Module\s+(\d+)\s*:\s*(Reading and Writing|Math)/i);
  if (!match) {
    match = clean.match(/Module\s+(\d+)\s*:\s*(Reading and Writing|Math)/i);
    if (match) match = [match[0], "1", match[1], match[2]];
  }
  if (!match) return currentModule;

  const moduleNumber = Number(match[2]);
  const section = /math/i.test(match[3]) ? "Math" : "Reading and Writing";
  let key = "";
  if (section === "Reading and Writing") key = moduleNumber === 1 ? "RW1" : "RW2";
  else key = moduleNumber === 1 ? "M1" : "M2";

  return {key, name: `${section} Module ${moduleNumber}`, section, minutes: section === "Math" ? 35 : 32};
}

function splitQuestions(pageTexts){
  const questions = [];
  const moduleMap = new Map();
  let currentModule = {key:"RW1", name:"Reading and Writing Module 1", section:"Reading and Writing", minutes:32};
  let currentQuestion = null;

  for (const pageItem of pageTexts) {
    const lines = normalizeOcrText(pageItem.text).split("\n").map(l=>l.trim()).filter(Boolean);

    for (let raw of lines) {
      const possibleModule = detectModule(raw, currentModule);
      if (possibleModule.key !== currentModule.key) {
        currentModule = possibleModule;
        moduleMap.set(currentModule.key, {...currentModule});
      }

      raw = removeCommonNoise(raw);
      if (!raw) continue;

      const qMatch = raw.match(/^(\d{1,2})\.\s*(.*)$/);
      const standalone = raw.match(/^(\d{1,2})\.$/);

      if (qMatch || standalone) {
        if (currentQuestion && currentQuestion.text.trim()) questions.push(currentQuestion);
        const number = Number((qMatch || standalone)[1]);
        const rest = qMatch ? qMatch[2] : "";
        currentQuestion = {
          id: uid(),
          module: currentModule.key,
          moduleName: currentModule.name,
          section: currentModule.section,
          questionNumber: number,
          displayNumber: number,
          page: pageItem.page,
          text: rest ? rest + "\n" : "",
          type: "multiple_choice",
          correctAnswer: ""
        };
        moduleMap.set(currentModule.key, {...currentModule});
        continue;
      }

      if (currentQuestion) currentQuestion.text += raw + "\n";
    }
  }

  if (currentQuestion && currentQuestion.text.trim()) questions.push(currentQuestion);

  const cleaned = questions
    .filter(q => q.text.replace(/\s/g, "").length > 20)
    .map(q => ({...q, text: cleanQuestionBlock(q.text)}));

  for (const q of cleaned) {
    if (!moduleMap.has(q.module)) {
      moduleMap.set(q.module, {key:q.module, name:q.module, section:q.section, minutes:q.section==="Math"?35:32});
    }
  }

  const order = {RW1:1, RW2:2, M1:3, M2:4};
  const modules = [...moduleMap.values()].sort((a,b)=>(order[a.key]||99)-(order[b.key]||99)).map((m, idx) => ({...m, order: idx + 1}));
  return {questions: cleaned, modules};
}

function normalizeOcrText(text){
  return text
    .replace(/\r/g, "\n")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/—/g, "-")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

function removeCommonNoise(line){
  const bad = [/AODEFEN SAT/i,/HAODEFEN/i,/1500\+/i,/备考资料/i,/好得分/i,/SAT Shishengshuo/i,/^ef orc/i,/^\d{1,2}$/];
  if (bad.some(rx => rx.test(line))) return "";
  return line;
}

function cleanQuestionBlock(text){
  let out = text;
  out = out.replace(/Follow the official account SAT Shishengshuo for\s*more SAT preparation tips\.?/gi, "");
  out = out.replace(/\n\s+/g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

function renderExtractionPreview(){
  const preview = document.getElementById("extract-preview");
  const moduleList = document.getElementById("module-list");

  if (!extractedQuestions.length) {
    preview.innerHTML = "";
    moduleList.innerHTML = `<p class="muted">No modules detected yet.</p>`;
    return;
  }

  const counts = extractedModules.map(m => `${m.key}: ${extractedQuestions.filter(q=>q.module===m.key).length}`).join(" • ");

  preview.innerHTML = `<p class="muted"><strong>Detected:</strong> ${counts}</p>` + extractedQuestions.slice(0, 12).map(q => `
    <div class="preview-q">
      <strong>${escapeHtml(q.module)} Q${q.questionNumber}</strong>
      <span class="meta">Page ${q.page} • ${escapeHtml(q.section)}</span>
      <p>${escapeHtml(q.text.slice(0, 260))}${q.text.length > 260 ? "..." : ""}</p>
    </div>
  `).join("") + (extractedQuestions.length > 12 ? `<p class="muted">Showing first 12 of ${extractedQuestions.length} extracted questions.</p>` : "");

  moduleList.innerHTML = extractedModules.map((m, i) => `
    <div class="module-row" data-module-key="${escapeHtml(m.key)}">
      <label>Key<input data-module-field="key" value="${escapeHtml(m.key)}" /></label>
      <label>Name<input data-module-field="name" value="${escapeHtml(m.name)}" /></label>
      <label>Minutes<input data-module-field="minutes" type="number" value="${m.minutes}" /></label>
      <label>Section<select data-module-field="section">
        <option ${m.section==="Reading and Writing" ? "selected" : ""}>Reading and Writing</option>
        <option ${m.section==="Math" ? "selected" : ""}>Math</option>
      </select></label>
    </div>
  `).join("");
}

function readModuleEdits(){
  return [...document.querySelectorAll(".module-row")].map((row, idx) => {
    const obj = {order: idx + 1};
    row.querySelectorAll("[data-module-field]").forEach(input => obj[input.dataset.moduleField] = input.value);
    obj.minutes = Number(obj.minutes);
    return obj;
  });
}

function parseAnswerKey(rows){
  const key = new Map();
  for (const row of rows) {
    if (!row.module || !row.question) continue;
    key.set(`${row.module}|${Number(row.question)}`, {
      correctAnswer: normalizeAnswer(row.correct_answer),
      type: row.type || "multiple_choice",
      section: row.section || ""
    });
  }
  return key;
}

function parseScoring(rows){
  return rows.filter(r=>r.section && r.raw_score && r.scaled_score).map(r=>({
    section:r.section,
    rawScore:Number(r.raw_score),
    scaledScore:Number(r.scaled_score)
  }));
}

async function handleUpload(e){
  e.preventDefault();
  if (!isAdmin()) return toast("Admin access required.");

  const pdf = document.getElementById("pdf-file").files[0];
  if (!pdf) return toast("Choose a PDF first.");
  if (!extractedQuestions.length) return toast("Extract questions before saving.");

  const answerFile = document.getElementById("answer-file").files[0];
  const scoringFile = document.getElementById("scoring-file").files[0];

  let answerMap = new Map();
  if (answerFile) answerMap = parseAnswerKey(parseCSV(await fileToText(answerFile)));

  const modules = readModuleEdits();
  const moduleByOldKey = new Map(extractedModules.map(m => [m.key, m]));
  const moduleByKey = new Map(modules.map((m, i) => [extractedModules[i]?.key || m.key, m]));

  const questions = extractedQuestions.map((q, idx) => {
    const moduleData = moduleByKey.get(q.module) || moduleByOldKey.get(q.module) || {key:q.module, section:q.section, name:q.module, minutes:q.section==="Math"?35:32};
    const answer = answerMap.get(`${q.module}|${q.questionNumber}`) || answerMap.get(`${moduleData.key}|${q.questionNumber}`) || {};
    return {
      ...q,
      id: `${moduleData.key}-${q.questionNumber}-${idx}`,
      module: moduleData.key,
      moduleName: moduleData.name,
      section: answer.section || moduleData.section || q.section,
      correctAnswer: answer.correctAnswer || "",
      type: answer.type || q.type || "multiple_choice"
    };
  });

  const scoringTable = scoringFile ? parseScoring(parseCSV(await fileToText(scoringFile))) : [];
  const fileId = uid();
  await saveFile(fileId, pdf, pdf.name, pdf.type);

  const test = {
    id: uid(),
    name: document.getElementById("test-name").value.trim(),
    folderDate: document.getElementById("folder-date").value || todayISO(),
    fileId,
    pdfName: pdf.name,
    modules,
    questions,
    scoringTable,
    createdBy: state.currentUser.id,
    createdAt: new Date().toISOString()
  };

  state.tests.push(test);
  saveMeta();

  extractedQuestions = [];
  extractedModules = [];
  document.getElementById("upload-form").reset();
  document.getElementById("folder-date").value = todayISO();
  setStatus("No PDF extracted yet.");
  renderExtractionPreview();

  toast("SAT saved with English, Math, and Full Test options.");
  showPage("library");
}

function showPage(id){
  if (id === "admin" && !isAdmin()) {
    toast("Admin access required.");
    id = "dashboard";
  }
  document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active", b.dataset.page === id));
  if (id !== "test-runner") stopTimer();
  if (id === "dashboard") renderDashboard();
  if (id === "library") renderLibrary();
  if (id === "history") renderHistory();
}

async function handleRegister(e){
  e.preventDefault();
  const username=document.getElementById("register-username").value.trim();
  const password=document.getElementById("register-password").value;
  const securityQuestion=document.getElementById("register-question").value.trim();
  const answer=document.getElementById("register-answer").value.trim();
  const wantsAdmin=document.getElementById("register-admin").checked;
  const code=document.getElementById("register-admin-code").value.trim();

  if (state.users.some(u=>u.username.toLowerCase()===username.toLowerCase())) return toast("Username already exists.");
  if (wantsAdmin && code !== ADMIN_CODE) return toast("Invalid admin invite code.");

  const user = {
    id: uid(),
    username,
    passHash: await sha(password),
    role: wantsAdmin ? "admin" : "student",
    securityQuestion,
    securityAnswerHash: await sha(answer.toLowerCase()),
    createdAt: new Date().toISOString()
  };
  state.users.push(user);
  state.currentUser = user;
  saveMeta();
  toast("Account created.");
  renderAuthState();
}

async function handleLogin(e){
  e.preventDefault();
  const username=document.getElementById("login-username").value.trim();
  const password=document.getElementById("login-password").value;
  const user=state.users.find(u=>u.username.toLowerCase()===username.toLowerCase());
  if (!user || user.passHash !== await sha(password)) return toast("Incorrect username or password.");
  state.currentUser = user;
  saveMeta();
  renderAuthState();
}

async function handleReset(e){
  e.preventDefault();
  const username=document.getElementById("reset-username").value.trim();
  const user=state.users.find(u=>u.username.toLowerCase()===username.toLowerCase());
  if (!user) return toast("User not found.");
  const answer=document.getElementById("reset-answer").value.trim().toLowerCase();
  const newPass=document.getElementById("reset-new-password").value;
  if (!answer || !newPass) return toast("Enter security answer and new password.");
  if (user.securityAnswerHash !== await sha(answer)) return toast("Security answer is incorrect.");
  user.passHash = await sha(newPass);
  saveMeta();
  toast("Password reset. You can log in.");
  document.querySelector('[data-auth-tab="login"]').click();
}

function getModulesForMode(test, mode){
  if (mode === "english") return test.modules.filter(m => m.section === "Reading and Writing");
  if (mode === "math") return test.modules.filter(m => m.section === "Math");
  return test.modules;
}

function getQuestionsForMode(test, mode){
  const modules = getModulesForMode(test, mode).map(m=>m.key);
  return test.questions.filter(q=>modules.includes(q.module));
}

function userAttempts(){
  return isAdmin() ? state.attempts : state.attempts.filter(a=>a.userId === state.currentUser.id);
}

function renderDashboard(){
  const attempts = userAttempts();
  document.getElementById("stat-tests").textContent = state.tests.length;
  document.getElementById("stat-attempts").textContent = attempts.length;
  document.getElementById("stat-best").textContent = attempts.length ? Math.max(...attempts.map(a=>a.totalScore || a.sectionScore || 0)) : "N/A";

  const recentTests = [...state.tests].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,5);
  document.getElementById("recent-tests").innerHTML = recentTests.length ? recentTests.map(testRowHtml).join("") : `<p class="muted">No tests uploaded yet.</p>`;

  const recentAttempts = [...attempts].sort((a,b)=>b.completedAt.localeCompare(a.completedAt)).slice(0,5);
  document.getElementById("recent-scores").innerHTML = recentAttempts.length ? recentAttempts.map(a=>scoreRowHtml(a)).join("") : `<p class="muted">No attempts yet.</p>`;
}

function testRowHtml(t){
  const englishCount = getQuestionsForMode(t, "english").length;
  const mathCount = getQuestionsForMode(t, "math").length;
  return `<div class="test-row">
    <div>
      <h4>${escapeHtml(t.name)}</h4>
      <div class="meta">
        Folder ${t.folderDate} • ${t.questions.length} extracted questions • 
        English ${englishCount} • Math ${mathCount}
      </div>
    </div>
    <div class="mode-buttons">
      <button class="primary small" onclick="startTest('${t.id}','english')" ${englishCount ? "" : "disabled"}>English</button>
      <button class="gold small" onclick="startTest('${t.id}','math')" ${mathCount ? "" : "disabled"}>Math</button>
      <button class="secondary small" onclick="startTest('${t.id}','full')">Full Test</button>
      ${isAdmin() ? `<button class="danger small" onclick="removeTest('${t.id}')">Delete</button>` : ""}
    </div>
  </div>`;
}

function renderLibrary(){
  const s = document.getElementById("test-search").value.toLowerCase();
  const filtered = state.tests.filter(t=>t.name.toLowerCase().includes(s) || t.folderDate.includes(s));
  const byDate = filtered.reduce((a,t)=>{(a[t.folderDate] ??= []).push(t); return a;}, {});
  const dates = Object.keys(byDate).sort((a,b)=>b.localeCompare(a));

  document.getElementById("library-list").innerHTML = dates.length ? dates.map(d=>`
    <div class="folder-group">
      <div class="folder-title">📁 ${d}</div>
      ${byDate[d].map(testRowHtml).join("")}
    </div>
  `).join("") : `<p class="muted">No tests found.</p>`;
}

function renderHistory(){
  const list = [...userAttempts()].sort((a,b)=>b.completedAt.localeCompare(a.completedAt));
  document.getElementById("history-list").innerHTML = list.length ? list.map(a=>scoreRowHtml(a,true)).join("") : `<p class="muted">No completed attempts yet.</p>`;
}

function scoreRowHtml(a,detailed=false){
  const t = state.tests.find(t=>t.id === a.testId);
  const user = state.users.find(u=>u.id === a.userId);
  const label = `<span class="mode-pill">${modeScoreLabel(a.mode || "full")}</span>`;
  let scoreText = "";
  if (a.mode === "english") scoreText = `English ${a.rwScore}`;
  else if (a.mode === "math") scoreText = `Math ${a.mathScore}`;
  else scoreText = `RW ${a.rwScore} • Math ${a.mathScore} • Total ${a.totalScore}`;
  return `<div class="score-row">
    <div>
      <h4>${label}${escapeHtml(t?.name || "Deleted Test")}</h4>
      <div class="meta">Taken ${new Date(a.completedAt).toLocaleString()} ${isAdmin()?`• ${escapeHtml(user?.username || "Unknown user")}`:""} • ${scoreText}${detailed ? ` • Raw RW ${a.rwRaw}/${a.rwTotal}, Math ${a.mathRaw}/${a.mathTotal}` : ""}</div>
    </div>
    <div class="row-actions"><button class="secondary small" onclick="viewAttempt('${a.id}')">View</button></div>
  </div>`;
}

async function startTest(testId, mode="full"){
  const test = state.tests.find(t=>t.id === testId);
  if (!test) return toast("Test not found.");

  const modules = getModulesForMode(test, mode);
  if (!modules.length) return toast(`No ${modeLabel(mode)} modules found for this test.`);

  const file = await getFile(test.fileId);
  if (!file) return toast("PDF file not found. Browser storage may have been cleared.");

  if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
  state.pdfUrl = URL.createObjectURL(file.blob);

  state.activeTest = test;
  state.activeMode = mode;
  state.activeModules = modules;
  state.currentModuleIndex = 0;
  state.currentQuestionIndex = 0;
  state.moduleStartedAt = Date.now();
  state.activeAttempt = {
    id: uid(),
    testId: test.id,
    userId: state.currentUser.id,
    mode,
    startedAt: new Date().toISOString(),
    responses: {},
    review: {},
    markup: {},
    moduleTimes: {}
  };

  document.getElementById("pdf-viewer").src = state.pdfUrl;
  document.getElementById("runner-title").textContent = `${test.name} • ${modeLabel(mode)}`;
  showPage("test-runner");
  renderRunner();
  startTimer();
}

function currentModule(){return state.activeModules[state.currentModuleIndex];}
function currentQuestions(){const m=currentModule();return state.activeTest.questions.filter(q=>q.module === m.key);}
function currentQuestion(){return currentQuestions()[state.currentQuestionIndex];}
function answerKeyFor(q){return `${q.module}|${q.questionNumber}`;}

function renderRunner(){
  const m = currentModule();
  const qs = currentQuestions();
  const q = currentQuestion();

  if (!q) {
    toast("No questions found for this module.");
    return;
  }

  const ans = state.activeAttempt.responses[answerKeyFor(q)] || "";
  const isGrid = (q.type || "").toLowerCase().includes("grid") || (q.correctAnswer && !["A","B","C","D"].includes(q.correctAnswer));
  const savedMarkup = state.activeAttempt.markup[answerKeyFor(q)];

  document.getElementById("module-label").textContent = `${modeLabel(state.activeMode)} • ${m.name} • ${m.minutes} minutes`;
  document.getElementById("math-tools").classList.toggle("hidden", m.section !== "Math");
  document.getElementById("question-progress").textContent = `${m.key} Question ${q.questionNumber} (${state.currentQuestionIndex + 1}/${qs.length})`;
  updateAnsweredCount();

  document.getElementById("question-panel").innerHTML = `
    <div class="question-card">
      <h3>${escapeHtml(m.key)} Question ${q.questionNumber}</h3>
      <p class="muted">${escapeHtml(m.name)} • Page ${q.page || "N/A"}</p>
      <div id="editable-question-text" class="question-text" contenteditable="true">${savedMarkup || escapeHtml(q.text || "No extracted text available.")}</div>
      ${isGrid ? `
        <label>Answer<input class="grid-input" id="active-answer-input" value="${escapeHtml(ans)}" placeholder="Type answer" /></label>
      ` : `
        <div class="choices">
          ${["A","B","C","D"].map(c=>`<div class="choice ${ans===c?"selected":""}" onclick="selectAnswer('${q.module}', ${q.questionNumber}, '${c}')"><input type="radio" readonly ${ans===c?"checked":""}/><span>${c}</span></div>`).join("")}
        </div>
      `}
    </div>
  `;

  const edit = document.getElementById("editable-question-text");
  edit.addEventListener("input",()=>state.activeAttempt.markup[answerKeyFor(q)] = edit.innerHTML);

  if (isGrid) {
    document.getElementById("active-answer-input").addEventListener("input", e=>{
      state.activeAttempt.responses[answerKeyFor(q)] = e.target.value.trim();
      renderQuestionGrid();
      updateAnsweredCount();
    });
  }

  document.getElementById("prev-question").disabled = state.currentQuestionIndex === 0;
  document.getElementById("next-question").textContent = state.currentQuestionIndex === qs.length - 1 ? "Finish Module" : "Next";
  document.getElementById("mark-review").textContent = state.activeAttempt.review[answerKeyFor(q)] ? "Unmark Review" : "Mark Review";
  renderQuestionGrid();
}

function updateAnsweredCount(){
  const qs = currentQuestions();
  const count = qs.filter(q=>state.activeAttempt.responses[answerKeyFor(q)]).length;
  document.getElementById("answered-count").textContent = `${count}/${qs.length} answered`;
}

function renderQuestionGrid(){
  const qs = currentQuestions();
  document.getElementById("question-grid").innerHTML = qs.map((q, idx)=>`
    <button class="q-pill ${state.activeAttempt.responses[answerKeyFor(q)]?"answered":""} ${state.activeAttempt.review[answerKeyFor(q)]?"review":""} ${idx===state.currentQuestionIndex?"current":""}" onclick="jumpQuestion(${idx})">${q.questionNumber}</button>
  `).join("");
}

function selectAnswer(module, questionNumber, choice){
  state.activeAttempt.responses[`${module}|${questionNumber}`] = choice;
  renderRunner();
}

function jumpQuestion(idx){state.currentQuestionIndex = idx; renderRunner();}
function nextQuestion(){
  const qs = currentQuestions();
  if (state.currentQuestionIndex < qs.length - 1) {
    state.currentQuestionIndex++;
    renderRunner();
  } else {
    submitModule();
  }
}
function prevQuestion(){if(state.currentQuestionIndex > 0){state.currentQuestionIndex--; renderRunner();}}
function toggleReview(){
  const q = currentQuestion();
  const key = answerKeyFor(q);
  state.activeAttempt.review[key] = !state.activeAttempt.review[key];
  renderRunner();
}

function applyMarkup(type){
  const sel = window.getSelection();
  if (!sel.rangeCount) return toast("Select question text first.");
  const container = document.getElementById("editable-question-text");
  if (!container || !container.contains(sel.anchorNode)) return toast("Select text inside the question text box.");
  const range = sel.getRangeAt(0);
  const wrapper = document.createElement(type === "highlight" ? "mark" : "u");
  wrapper.appendChild(range.extractContents());
  range.insertNode(wrapper);
  sel.removeAllRanges();
  state.activeAttempt.markup[answerKeyFor(currentQuestion())] = container.innerHTML;
}

function clearMarkup(){
  const el = document.getElementById("editable-question-text");
  if (!el) return;
  el.innerHTML = el.textContent;
  state.activeAttempt.markup[answerKeyFor(currentQuestion())] = el.innerHTML;
}

function insertFormula(text){
  const input = document.getElementById("active-answer-input");
  if (!input) return toast("Formula helper works with typed math answers.");
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0,start) + text + input.value.slice(end);
  input.focus();
  input.selectionStart = input.selectionEnd = start + text.length;
  state.activeAttempt.responses[answerKeyFor(currentQuestion())] = input.value;
  renderQuestionGrid();
  updateAnsweredCount();
}

function startTimer(){stopTimer();state.moduleStartedAt=Date.now();state.timerInterval=setInterval(updateTimer,1000);updateTimer();}
function stopTimer(){if(state.timerInterval){clearInterval(state.timerInterval);state.timerInterval=null;}}
function updateTimer(){
  if (!state.activeTest) return;
  const m = currentModule();
  const elapsed = Math.floor((Date.now() - state.moduleStartedAt) / 1000);
  const rem = Math.max(0, m.minutes * 60 - elapsed);
  document.getElementById("timer").textContent = `${String(Math.floor(rem/60)).padStart(2,"0")}:${String(rem%60).padStart(2,"0")}`;
  if (rem <= 0) {
    toast("Time is up. Module submitted.");
    submitModule();
  }
}

function submitModule(){
  const m = currentModule();
  state.activeAttempt.moduleTimes[m.key] = Math.floor((Date.now() - state.moduleStartedAt) / 1000);

  if (state.currentModuleIndex < state.activeModules.length - 1) {
    state.currentModuleIndex++;
    state.currentQuestionIndex = 0;
    state.moduleStartedAt = Date.now();
    toast("Module submitted. Next module started.");
    renderRunner();
    startTimer();
  } else {
    finishAttempt();
  }
}

function finishAttempt(){
  stopTimer();
  const scored = scoreAttempt(state.activeTest, state.activeAttempt, state.activeMode);
  const final = {...state.activeAttempt, ...scored, completedAt: new Date().toISOString()};
  state.attempts.push(final);
  saveMeta();
  state.activeAttempt = final;
  renderResults(final);
  showPage("results");
}

function scaledScore(test, section, raw, total){
  const exact = test.scoringTable.find(r=>r.section === section && r.rawScore === raw);
  if (exact) return exact.scaledScore;
  if (!total) return 200;
  return Math.round((200 + (raw / total) * 600) / 10) * 10;
}

function scoreAttempt(test, attempt, mode){
  const activeQuestionSet = getQuestionsForMode(test, mode).filter(q=>q.correctAnswer);
  const rw = activeQuestionSet.filter(q=>q.section === "Reading and Writing");
  const math = activeQuestionSet.filter(q=>q.section === "Math");

  const sectionScore = qs => qs.reduce((sum,q)=>{
    const selected = normalizeAnswer(attempt.responses[answerKeyFor(q)]);
    return sum + (selected && selected === normalizeAnswer(q.correctAnswer) ? 1 : 0);
  }, 0);

  const rwRaw = sectionScore(rw);
  const mathRaw = sectionScore(math);
  const rwScore = rw.length ? scaledScore(test, "Reading and Writing", rwRaw, rw.length) : 0;
  const mathScore = math.length ? scaledScore(test, "Math", mathRaw, math.length) : 0;
  const totalScore = mode === "english" ? rwScore : mode === "math" ? mathScore : rwScore + mathScore;
  return {rwRaw, mathRaw, rwTotal:rw.length, mathTotal:math.length, rwScore, mathScore, totalScore};
}

function renderResults(a){
  const test = state.tests.find(t=>t.id === a.testId);
  const mode = a.mode || "full";
  let summaryCards = "";
  if (mode === "english") {
    summaryCards = `<div class="result-card"><span>English Score</span><strong>${a.rwScore}</strong><p class="muted">Raw ${a.rwRaw}/${a.rwTotal}</p></div>`;
  } else if (mode === "math") {
    summaryCards = `<div class="result-card"><span>Math Score</span><strong>${a.mathScore}</strong><p class="muted">Raw ${a.mathRaw}/${a.mathTotal}</p></div>`;
  } else {
    summaryCards = `
      <div class="result-card"><span>Total Score</span><strong>${a.totalScore}</strong><p class="muted">Estimated scaled score</p></div>
      <div class="result-card"><span>Reading and Writing</span><strong>${a.rwScore}</strong><p class="muted">Raw ${a.rwRaw}/${a.rwTotal}</p></div>
      <div class="result-card"><span>Math</span><strong>${a.mathScore}</strong><p class="muted">Raw ${a.mathRaw}/${a.mathTotal}</p></div>`;
  }

  document.getElementById("results-summary").innerHTML = `
    <p><span class="mode-pill">${modeLabel(mode)}</span></p>
    <div class="result-grid">${summaryCards}</div>
  `;

  const reviewed = getQuestionsForMode(test, mode).filter(q=>q.correctAnswer);
  document.getElementById("results-details").innerHTML = `
    <h3>Question Review</h3>
    <table class="review-table">
      <thead><tr><th>Module</th><th>Q</th><th>Your Answer</th><th>Correct</th><th>Result</th></tr></thead>
      <tbody>${reviewed.map(q=>{
        const selected = normalizeAnswer(a.responses[answerKeyFor(q)]) || "Blank";
        const correct = normalizeAnswer(q.correctAnswer);
        const ok = selected === correct;
        return `<tr><td>${escapeHtml(q.module)}</td><td>${q.questionNumber}</td><td>${escapeHtml(selected)}</td><td>${escapeHtml(correct)}</td><td class="${ok?"correct":"incorrect"}">${ok?"Correct" : "Incorrect"}</td></tr>`;
      }).join("")}</tbody>
    </table>
  `;
}

function viewAttempt(id){
  const a = state.attempts.find(x=>x.id === id);
  if (!a) return toast("Attempt not found.");
  renderResults(a);
  showPage("results");
}

async function removeTest(id){
  if (!isAdmin()) return;
  if (!confirm("Delete this test and its uploaded PDF? Attempts will remain.")) return;
  const t = state.tests.find(t=>t.id === id);
  if (t?.fileId) await deleteFile(t.fileId);
  state.tests = state.tests.filter(t=>t.id !== id);
  saveMeta();
  renderLibrary();
  toast("Test deleted.");
}

function exportHistory(){
  const blob = new Blob([JSON.stringify({exportedAt:new Date().toISOString(),user:state.currentUser.username,attempts:userAttempts()}, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dh-sat-history-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function bindEvents(){
  document.querySelectorAll("#auth-logo,#site-logo").forEach(setupLogo);

  document.querySelectorAll("[data-auth-tab]").forEach(btn=>btn.addEventListener("click",()=>{
    document.querySelectorAll("[data-auth-tab]").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".auth-panel").forEach(p=>p.classList.remove("active"));
    document.getElementById(`${btn.dataset.authTab}-form`).classList.add("active");
  }));

  document.getElementById("register-admin").addEventListener("change",e=>document.getElementById("admin-code-wrap").classList.toggle("hidden", !e.target.checked));
  document.getElementById("login-form").addEventListener("submit", handleLogin);
  document.getElementById("register-form").addEventListener("submit", handleRegister);
  document.getElementById("reset-form").addEventListener("submit", handleReset);
  document.getElementById("find-reset-question").addEventListener("click",()=>{
    const u = state.users.find(x=>x.username.toLowerCase() === document.getElementById("reset-username").value.trim().toLowerCase());
    if (!u) return toast("User not found.");
    document.getElementById("reset-question-box").classList.remove("hidden");
    document.getElementById("reset-question-text").textContent = u.securityQuestion;
  });

  document.querySelectorAll(".nav-btn").forEach(b=>b.addEventListener("click",()=>showPage(b.dataset.page)));
  document.querySelectorAll("[data-goto]").forEach(b=>b.addEventListener("click",()=>showPage(b.dataset.goto)));
  document.getElementById("logout").addEventListener("click",()=>{state.currentUser=null;saveMeta();renderAuthState();});

  document.getElementById("extract-fast").addEventListener("click",()=>extractPdfText("fast"));
  document.getElementById("extract-ocr").addEventListener("click",()=>extractPdfText("ocr"));
  document.getElementById("upload-form").addEventListener("submit", handleUpload);

  document.getElementById("test-search").addEventListener("input", renderLibrary);
  document.getElementById("export-history").addEventListener("click", exportHistory);

  document.getElementById("exit-test").addEventListener("click",()=>{if(confirm("Exit this test? Current attempt will be lost."))showPage("library");});
  document.getElementById("next-question").addEventListener("click", nextQuestion);
  document.getElementById("prev-question").addEventListener("click", prevQuestion);
  document.getElementById("mark-review").addEventListener("click", toggleReview);
  document.getElementById("submit-module").addEventListener("click",()=>{if(confirm("Submit this module?"))submitModule();});

  document.getElementById("highlight-btn").addEventListener("click",()=>applyMarkup("highlight"));
  document.getElementById("underline-btn").addEventListener("click",()=>applyMarkup("underline"));
  document.getElementById("clear-markup-btn").addEventListener("click", clearMarkup);
  document.querySelectorAll("[data-insert]").forEach(b=>b.addEventListener("click",()=>insertFormula(b.dataset.insert)));
}

async function init(){
  db = await openDb();
  const meta = loadMeta();
  state.users = meta.users || [];
  state.tests = meta.tests || [];
  state.attempts = meta.attempts || [];
  state.currentUser = state.users.find(u=>u.id === meta.currentUserId) || null;
  document.getElementById("folder-date").value = todayISO();
  bindEvents();
  renderExtractionPreview();
  renderAuthState();
}

init().catch(e=>{console.error(e);toast("Could not start app. Browser storage may be blocked.");});