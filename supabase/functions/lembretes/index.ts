// Edge Function: lembretes (v5)
// Chamada a cada minuto pelo Cron do Supabase (header x-cron-key).
// 1) gera os envios que vencem agora (no fuso de cada pessoa)
// 2) envia pendentes: WhatsApp (Z-API, se configurada) + PUSH para toda a rede de cuidado da pessoa
// 3) reenvia uma vez após N minutos sem resposta; depois marca sem_resposta e avisa a rede
// GET ?acao=chave (público) → chave pública VAPID, para o painel ativar os avisos no aparelho.
// Nenhuma falha é silenciosa: tudo vai para a tabela envios (status/erro) e para o log.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import postgres from "npm:postgres@3.4.5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ZAPI_INSTANCE = Deno.env.get("ZAPI_INSTANCE_ID") ?? "";
const ZAPI_TOKEN = Deno.env.get("ZAPI_TOKEN") ?? "";
const ZAPI_CLIENT_TOKEN = Deno.env.get("ZAPI_CLIENT_TOKEN") ?? "";
const CRON_KEY = Deno.env.get("CRON_KEY") ?? "";
const PAINEL_URL = Deno.env.get("PAINEL_URL") || "https://stellar-raindrop-1ab6e5.netlify.app";
const VERSAO_LEMBRETES = "v5";

const TOLERANCIA_MIN = 3; // janela: dispara se o horário venceu nos últimos 3 min

const db = createClient(SUPABASE_URL, SERVICE_KEY);

// ---------- cofre (chaves VAPID do push, geradas uma única vez) ----------
let _sql: ReturnType<typeof postgres> | null = null;
const banco = () => (_sql ??= postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 5 }));
async function segredo(nome: string): Promise<string | null> {
  const [s] = await banco()`select decrypted_secret from vault.decrypted_secrets where name = ${nome}`;
  return s?.decrypted_secret ? String(s.decrypted_secret) : null;
}
let _vapid: { publica: string; privada: string } | null = null;
async function vapid() {
  if (_vapid) return _vapid;
  let publica = await segredo("vapid_publica"), privada = await segredo("vapid_privada");
  if (!publica || !privada) {
    // primeira vez: gera o par e guarda no cofre (a chave privada nunca sai do servidor)
    const k = webpush.generateVAPIDKeys();
    await banco()`select vault.create_secret(${k.privateKey}, 'vapid_privada', 'Chave privada VAPID (VigilCare)') where not exists (select 1 from vault.secrets where name = 'vapid_privada')`;
    await banco()`select vault.create_secret(${k.publicKey}, 'vapid_publica', 'Chave pública VAPID (VigilCare)') where not exists (select 1 from vault.secrets where name = 'vapid_publica')`;
    publica = await segredo("vapid_publica"); privada = await segredo("vapid_privada");
  }
  _vapid = { publica: publica!, privada: privada! };
  return _vapid;
}

// ---------- push para a rede de cuidado de uma pessoa ----------
// Recebem: o administrador (inscrições sem usuário) + todos os usuários vinculados à pessoa, nos aparelhos em que ativaram os avisos.
type MsgPush = { titulo: string; corpo: string; tag?: string };
async function pushRede(pessoaId: string, msg: MsgPush, envioIdTomei?: string): Promise<number> {
  const { data: vinc, error: eV } = await db.from("usuarios_pessoas").select("usuario_id").eq("pessoa_id", pessoaId);
  if (eV) { console.error("pushRede vínculos:", eV.message); return 0; }
  const ids = (vinc ?? []).map((v) => v.usuario_id);
  let q = db.from("push_inscricoes").select("id, endpoint, p256dh, auth, usuario_id, rotulo");
  q = ids.length ? q.or(`usuario_id.is.null,usuario_id.in.(${ids.join(",")})`) : q.is("usuario_id", null);
  const { data: subs, error: eS } = await q;
  if (eS) { console.error("pushRede inscrições:", eS.message); return 0; }
  if (!subs || !subs.length) return 0;
  const v = await vapid();
  let ok = 0;
  for (const s of subs) {
    try {
      const nome = s.usuario_id ? (s.rotulo || "Usuário") : "Administrador";
      let acoes: { id: string; titulo: string; url: string }[] | undefined;
      if (envioIdTomei) {
        const { data: tk, error: eT } = await db.from("envio_tokens").insert({ envio_id: envioIdTomei, usuario_id: s.usuario_id, nome }).select("id").single();
        if (eT) { console.error("pushRede token:", eT.message); }
        else acoes = [{ id: "tomei", titulo: "✓ Tomei", url: "/?tok=" + tk.id + "&r=tomei" }, { id: "abrir", titulo: "Abrir painel", url: "/" }];
      }
      const det = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ titulo: msg.titulo, corpo: msg.corpo, url: "/", tag: msg.tag, acoes }),
        { vapidDetails: { subject: PAINEL_URL, publicKey: v.publica, privateKey: v.privada }, TTL: 1800, urgency: "high" });
      const r = await fetch(det.endpoint, { method: "POST", headers: det.headers as Record<string, string>, body: det.body });
      if (r.status === 404 || r.status === 410) { await db.from("push_inscricoes").delete().eq("id", s.id); continue; }
      if (!r.ok) { console.error("push", r.status, (await r.text()).slice(0, 200)); continue; }
      ok++;
    } catch (e) { console.error("push", String(e).slice(0, 200)); }
  }
  return ok;
}

// ---------- fuso horário ----------
function partesNoFuso(d: Date, fuso: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: fuso, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  const dias: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    ano: +p.year, mes: +p.month, dia: +p.day,
    hora: +p.hour === 24 ? 0 : +p.hour, minuto: +p.minute,
    diaSemana: dias[p.weekday],
  };
}

// converte "data local + hora local no fuso" em instante UTC
function localParaUTC(ano: number, mes: number, dia: number, hora: number, minuto: number, fuso: string): Date {
  const palpite = Date.UTC(ano, mes - 1, dia, hora, minuto);
  const p = partesNoFuso(new Date(palpite), fuso);
  const visto = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto);
  return new Date(palpite - (visto - palpite));
}

function saudacao(hora: number) {
  if (hora < 12) return "Bom dia";
  if (hora < 18) return "Boa tarde";
  return "Boa noite";
}

async function aguaHojeMl(pessoaId: string, fuso: string, agora: Date): Promise<number> {
  const p = partesNoFuso(agora, fuso);
  const inicioDia = localParaUTC(p.ano, p.mes, p.dia, 0, 0, fuso).toISOString();
  const { data, error } = await db.from("agua_registros").select("ml").eq("pessoa_id", pessoaId).gte("registrado_em", inicioDia);
  if (error) throw new Error("agua_registros: " + error.message);
  return (data ?? []).reduce((s, r) => s + r.ml, 0);
}

function hhmm(horario: string) {
  return horario.slice(0, 5);
}

// ---------- Z-API ----------
async function enviarWhats(telefone: string, mensagem: string): Promise<{ ok: boolean; id?: string; erro?: string }> {
  if (!ZAPI_INSTANCE || !ZAPI_TOKEN || !ZAPI_CLIENT_TOKEN) {
    return { ok: false, erro: "Segredos da Z-API não configurados" };
  }
  try {
    const r = await fetch(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Client-Token": ZAPI_CLIENT_TOKEN },
      body: JSON.stringify({ phone: telefone, message: mensagem }),
    });
    const texto = await r.text();
    if (!r.ok) return { ok: false, erro: `Z-API HTTP ${r.status}: ${texto.slice(0, 300)}` };
    let id: string | undefined;
    try { const j = JSON.parse(texto); id = j.messageId ?? j.zaapId ?? j.id; } catch { /* resposta sem JSON */ }
    return { ok: true, id };
  } catch (e) {
    return { ok: false, erro: `Falha de rede Z-API: ${String(e).slice(0, 300)}` };
  }
}

async function avisarAdmin(mensagem: string) {
  const { data } = await db.from("config").select("valor").eq("chave", "admin_telefone").single();
  const tel = (data?.valor ?? "").replace(/\D/g, "");
  if (!tel) { console.warn("admin_telefone vazio — aviso não enviado:", mensagem); return; }
  const r = await enviarWhats(tel, mensagem);
  if (!r.ok) console.error("Falha ao avisar admin:", r.erro);
}

async function avisarGrupo(grupo: string | null | undefined, mensagem: string) {
  const g = (grupo ?? "").trim();
  if (!g) return;
  const r = await enviarWhats(g, mensagem);
  if (!r.ok) console.error("Falha ao avisar grupo:", r.erro);
}

// ---------- passo 1: gerar envios que vencem agora ----------
async function gerarEnvios(agora: Date) {
  const { data: ags, error } = await db
    .from("agendamentos")
    .select("id, pessoa_id, tipo, horario, dias_semana, medicacao_id, pessoas!inner(id, ativa, fuso), medicacoes(ativa, uso, inicio, fim)")
    .eq("ativo", true)
    .eq("pessoas.ativa", true);
  if (error) throw new Error("agendamentos: " + error.message);

  let criados = 0;
  for (const a of ags ?? []) {
    const pessoa = a.pessoas as unknown as { fuso: string };
    const med = a.medicacoes as unknown as { ativa: boolean; uso: string; inicio: string | null; fim: string | null } | null;
    if (a.tipo === "medicacao" && med?.ativa === false) continue;

    const local = partesNoFuso(agora, pessoa.fuso);
    if (a.tipo === "medicacao" && med?.uso === "periodo") {
      const hojeLocal = `${local.ano}-${String(local.mes).padStart(2, "0")}-${String(local.dia).padStart(2, "0")}`;
      if ((med.inicio && hojeLocal < med.inicio) || (med.fim && hojeLocal > med.fim)) continue; // fora do período
    }
    if (!(a.dias_semana as number[]).includes(local.diaSemana)) continue;

    const [h, m] = (a.horario as string).split(":").map(Number);
    const alvo = localParaUTC(local.ano, local.mes, local.dia, h, m, pessoa.fuso);
    const difMin = (agora.getTime() - alvo.getTime()) / 60000;
    if (difMin < 0 || difMin > TOLERANCIA_MIN) continue;

    const { error: e2 } = await db.from("envios").upsert(
      { pessoa_id: a.pessoa_id, agendamento_id: a.id, tipo: a.tipo, previsto_em: alvo.toISOString(), status: "pendente" },
      { onConflict: "agendamento_id,previsto_em", ignoreDuplicates: true },
    );
    if (e2) throw new Error("criar envio: " + e2.message);
    criados++;
  }
  return criados;
}

// título e corpo do push de um lembrete
function pushDoLembrete(tipo: string, nomePessoa: string, ag: { horario: string; contexto: string | null; medicacoes: { nome: string; dose: string | null } | null }): MsgPush {
  if (tipo === "medicacao") {
    const med = ag.medicacoes;
    return { titulo: `💊 Hora do remédio — ${nomePessoa}`, corpo: `${med?.nome ?? "Medicação"}${med?.dose ? " " + med.dose : ""} · ${hhmm(ag.horario)}` };
  }
  if (tipo === "glicemia") {
    const ctx = ag.contexto === "jejum" ? " em jejum" : ag.contexto === "pos_refeicao" ? " após a refeição" : "";
    return { titulo: `🩸 Glicemia — ${nomePessoa}`, corpo: `Hora de medir a glicemia${ctx} (${hhmm(ag.horario)}).` };
  }
  if (tipo === "oximetria") return { titulo: `🫁 Oximetria — ${nomePessoa}`, corpo: `Hora de medir a saturação e os batimentos (${hhmm(ag.horario)}).` };
  if (tipo === "peso") return { titulo: `⚖️ Peso — ${nomePessoa}`, corpo: `Hora de se pesar (${hhmm(ag.horario)}).` };
  if (tipo === "agua") return { titulo: `💧 Água — ${nomePessoa}`, corpo: `Hora de beber água.` };
  return { titulo: `🩺 Pressão — ${nomePessoa}`, corpo: `Hora de medir a pressão (${hhmm(ag.horario)}).` };
}

// ---------- passo 2: enviar pendentes ----------
async function enviarPendentes(agora: Date) {
  const { data: pend, error } = await db
    .from("envios")
    .select("id, pessoa_id, tipo, previsto_em, pessoas(nome, telefone, fuso, agua_meta_ml, grupo_whats), agendamentos(horario, contexto, medicacoes(nome, dose))")
    .eq("status", "pendente")
    .is("enviado_em", null)
    .limit(50);
  if (error) throw new Error("pendentes: " + error.message);

  let ok = 0, falhas = 0, pushes = 0;
  for (const e of pend ?? []) {
    const p = e.pessoas as unknown as { nome: string; telefone: string; fuso: string; agua_meta_ml: number; grupo_whats: string | null };
    const ag = e.agendamentos as unknown as { horario: string; contexto: string | null; medicacoes: { nome: string; dose: string | null } | null };
    const hora = partesNoFuso(agora, p.fuso).hora;
    let msg: string;
    if (e.tipo === "glicemia") {
      const ctx = ag.contexto === "jejum" ? " em jejum" : ag.contexto === "pos_refeicao" ? " após a refeição" : "";
      msg = `${saudacao(hora)}, ${p.nome}! Pode medir a glicemia${ctx}? Envie só o número, ex.: 95.`;
    } else if (e.tipo === "oximetria") {
      msg = `${saudacao(hora)}, ${p.nome}! Coloque o oxímetro no dedo e envie a saturação e os batimentos, ex.: 97% 72.`;
    } else if (e.tipo === "peso") {
      msg = `${saudacao(hora)}, ${p.nome}! Pode se pesar e enviar o peso? Ex.: 78,4`;
    } else if (e.tipo === "medicacao") {
      const med = ag.medicacoes;
      const dose = med?.dose ? ` ${med.dose}` : "";
      msg = `${saudacao(hora)}, ${p.nome}! Hora do remédio: ${med?.nome ?? "medicação"}${dose} (${hhmm(ag.horario)}). Responda 1 quando tomar.`;
    } else if (e.tipo === "agua") {
      const total = await aguaHojeMl(e.pessoa_id as string, p.fuso, agora);
      msg = `${p.nome}, hora de beber água! Hoje você já registrou ${total} ml (meta ${p.agua_meta_ml} ml). Responda com a quantidade, ex.: 300ml ou 1 copo.`;
    } else {
      msg = `${saudacao(hora)}, ${p.nome}! Pode medir sua pressão agora? Envie no formato 120/80 (ou 120/80 72 com o pulso).`;
    }

    const r = await enviarWhats(p.telefone, msg);
    const push = pushDoLembrete(e.tipo as string, p.nome, ag);
    const entregues = await pushRede(e.pessoa_id as string, { ...push, tag: "vc-env-" + e.id }, e.tipo === "medicacao" ? (e.id as string) : undefined);
    pushes += entregues;
    if (r.ok || entregues > 0) {
      await db.from("envios").update({ status: "enviado", enviado_em: agora.toISOString(), zapi_id: r.id ?? null, erro: r.ok ? null : r.erro }).eq("id", e.id);
      ok++;
    } else {
      await db.from("envios").update({ status: "erro", erro: `${r.erro ?? "WhatsApp falhou"}; push: nenhum aparelho inscrito` }).eq("id", e.id);
      console.error("Falha de envio", e.id, r.erro);
      await avisarAdmin(`⚠️ Falha ao enviar lembrete para ${p.nome}: ${r.erro}`);
      await avisarGrupo(p.grupo_whats, `⚠️ Falha ao enviar lembrete para ${p.nome}.`);
      falhas++;
    }
  }
  return { ok, falhas, pushes };
}

// ---------- passo 3: reenvio e sem resposta ----------
async function tratarSemResposta(agora: Date) {
  const { data: cfg } = await db.from("config").select("valor").eq("chave", "reenvio_minutos").single();
  const minutos = Math.max(5, Number(cfg?.valor) || 30);
  const limite = new Date(agora.getTime() - minutos * 60000).toISOString();

  // 3a) primeiro reenvio
  const { data: r1, error: e1 } = await db
    .from("envios")
    .select("id, pessoa_id, tipo, pessoas(nome, telefone), agendamentos(horario, contexto, medicacoes(nome, dose))")
    .eq("status", "enviado").not("tipo", "in", "(agua,peso)").is("reenviado_em", null).lt("enviado_em", limite).limit(50);
  if (e1) throw new Error("reenvio: " + e1.message);

  let reenviados = 0, semResposta = 0;
  for (const e of r1 ?? []) {
    const p = e.pessoas as unknown as { nome: string; telefone: string };
    const ag = e.agendamentos as unknown as { horario: string; contexto: string | null; medicacoes: { nome: string; dose: string | null } | null };
    const msg = e.tipo === "medicacao"
      ? `Lembrete, ${p.nome}: ainda não recebi a confirmação do ${ag.medicacoes?.nome ?? "remédio"} das ${hhmm(ag.horario)}. Responda 1 quando tomar.`
      : e.tipo === "glicemia" ? `Lembrete, ${p.nome}: ainda não recebi sua glicemia. Envie só o número, ex.: 95.`
      : e.tipo === "oximetria" ? `Lembrete, ${p.nome}: ainda não recebi a saturação e os batimentos. Ex.: 97% 72.`
      : `Lembrete, ${p.nome}: ainda não recebi sua pressão. Envie no formato 120/80.`;
    const r = await enviarWhats(p.telefone, msg);
    const base = pushDoLembrete(e.tipo as string, p.nome, ag);
    const entregues = await pushRede(e.pessoa_id as string, { titulo: "⏰ Ainda sem resposta — " + p.nome, corpo: base.corpo, tag: "vc-env-" + e.id }, e.tipo === "medicacao" ? (e.id as string) : undefined);
    if (r.ok || entregues > 0) { await db.from("envios").update({ reenviado_em: agora.toISOString() }).eq("id", e.id); reenviados++; }
    else console.error("Falha no reenvio", e.id, r.erro);
  }

  // 3b) já reenviou e continua sem resposta → sem_resposta + aviso à rede
  const { data: r2, error: e2 } = await db
    .from("envios")
    .select("id, pessoa_id, tipo, pessoas(nome, grupo_whats), agendamentos(horario, medicacoes(nome))")
    .eq("status", "enviado").not("reenviado_em", "is", null).lt("reenviado_em", limite).limit(50);
  if (e2) throw new Error("sem_resposta: " + e2.message);

  // água sem resposta encerra em silêncio (sem reenvio e sem aviso ao admin)
  const { error: eAgua } = await db.from("envios").update({ status: "sem_resposta" }).eq("status", "enviado").in("tipo", ["agua", "peso"]).lt("enviado_em", limite);
  if (eAgua) throw new Error("agua sem_resposta: " + eAgua.message);
  for (const e of r2 ?? []) {
    const p = e.pessoas as unknown as { nome: string; grupo_whats: string | null };
    const ag = e.agendamentos as unknown as { horario: string; medicacoes: { nome: string } | null };
    await db.from("envios").update({ status: "sem_resposta" }).eq("id", e.id);
    const rot: Record<string, string> = { pressao: "aferição de pressão", glicemia: "glicemia", oximetria: "oximetria" };
    const oque = e.tipo === "medicacao" ? `${ag.medicacoes?.nome ?? "remédio"} das ${hhmm(ag.horario)}` : `${rot[e.tipo] ?? e.tipo} das ${hhmm(ag.horario)}`;
    await avisarAdmin(`⚠️ ${p.nome} não respondeu: ${oque}.`);
    await avisarGrupo(p.grupo_whats, `⚠️ ${p.nome} não respondeu: ${oque}.`);
    await pushRede(e.pessoa_id as string, { titulo: `⚠️ ${p.nome} não respondeu`, corpo: oque + " — vale conferir.", tag: "vc-sr-" + e.id });
    semResposta++;
  }
  return { reenviados, semResposta };
}

// ---------- avisos de consulta ----------
async function avisarConsultas(agora: Date) {
  const { data: cons, error } = await db
    .from("consultas")
    .select("id, pessoa_id, descricao, local, data_hora, antecedencias, avisar_paciente, avisar_admin, tipo, pessoas!inner(nome, telefone, fuso, ativa, grupo_whats)")
    .eq("status", "agendada")
    .gte("data_hora", agora.toISOString())
    .lte("data_hora", new Date(agora.getTime() + 31 * 86400000).toISOString());
  if (error) throw new Error("consultas: " + error.message);

  let avisos = 0;
  for (const c of cons ?? []) {
    const p = c.pessoas as unknown as { nome: string; telefone: string; fuso: string; ativa: boolean; grupo_whats: string | null };
    const difMin = (new Date(c.data_hora as string).getTime() - agora.getTime()) / 60000;
    for (const ant of (c.antecedencias as number[]) ?? []) {
      if (!(difMin <= ant && difMin > ant - 10)) continue; // janela de 10 min recupera atrasos do cron
      const { error: eIns } = await db.from("consulta_avisos").insert({ consulta_id: c.id, antecedencia_min: ant });
      if (eIns) {
        if (eIns.code === "23505") continue; // já avisado
        throw new Error("consulta_avisos: " + eIns.message);
      }
      const dt = new Date(c.data_hora as string);
      const quando = new Intl.DateTimeFormat("pt-BR", { timeZone: p.fuso, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(dt);
      const rotulo = c.tipo === "retorno" ? "retorno" : "consulta";
      const msg = `Lembrete de ${rotulo}: ${c.descricao}, ${quando}${c.local ? ` — ${c.local}` : ""}.`;
      if (c.avisar_paciente && p.ativa) {
        const r = await enviarWhats(p.telefone, `${p.nome}, ${msg}`);
        if (!r.ok) { console.error("Falha aviso consulta", c.id, r.erro); await avisarAdmin(`⚠️ Falha ao avisar ${p.nome} sobre ${rotulo}: ${r.erro}`); }
      }
      if (c.avisar_admin) await avisarAdmin(`📅 ${p.nome} — ${msg}`);
      await avisarGrupo(p.grupo_whats, `📅 ${p.nome} — ${msg}`);
      await pushRede(c.pessoa_id as string, { titulo: `📅 ${rotulo === "retorno" ? "Retorno" : "Consulta"} — ${p.nome}`, corpo: `${c.descricao}, ${quando}${c.local ? ` — ${c.local}` : ""}`, tag: "vc-con-" + c.id });
      avisos++;
    }
  }
  return avisos;
}

// ---------- handler ----------
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-cron-key", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  // público: chave VAPID para o painel ativar os avisos
  if (req.method === "GET" && url.searchParams.get("acao") === "chave") {
    try { return new Response(JSON.stringify({ chave: (await vapid()).publica, versao: VERSAO_LEMBRETES }), { headers: { ...CORS, "Content-Type": "application/json" } }); }
    catch (e) { return new Response(JSON.stringify({ erro: String(e).slice(0, 300) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }); }
  }
  if (!CRON_KEY || req.headers.get("x-cron-key") !== CRON_KEY) {
    return new Response(JSON.stringify({ erro: "não autorizado" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const agora = new Date();
  try {
    const criados = await gerarEnvios(agora);
    const env = await enviarPendentes(agora);
    const sr = await tratarSemResposta(agora);
    const consultas = await avisarConsultas(agora);
    const resumo = { versao: VERSAO_LEMBRETES, agora: agora.toISOString(), criados, ...env, ...sr, consultas };
    console.log(JSON.stringify(resumo));
    return new Response(JSON.stringify(resumo), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    const msg = String(e);
    console.error("ERRO lembretes:", msg);
    await avisarAdmin(`⚠️ Erro no disparador de lembretes: ${msg.slice(0, 200)}`);
    return new Response(JSON.stringify({ erro: msg }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
