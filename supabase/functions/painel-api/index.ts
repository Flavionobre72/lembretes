// Edge Function: painel-api
// Único ponto de acesso do painel ao banco. Toda chamada é POST JSON: { senha, acao, ...dados }
// A senha é comparada com o segredo PAINEL_SENHA. Sem senha válida → 401.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PAINEL_SENHA = Deno.env.get("PAINEL_SENHA") ?? "";
const ZAPI_INSTANCE = Deno.env.get("ZAPI_INSTANCE_ID") ?? "";
const ZAPI_TOKEN = Deno.env.get("ZAPI_TOKEN") ?? "";
const ZAPI_CLIENT_TOKEN = Deno.env.get("ZAPI_CLIENT_TOKEN") ?? "";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-6";
const ANTHROPIC_WORKSPACE_ID = Deno.env.get("ANTHROPIC_WORKSPACE_ID") ?? "";
const VERSAO_API = "v18";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM = Deno.env.get("RESEND_FROM") || "VigilCare <onboarding@resend.dev>";
const cabecalhosIA = () => ({ "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", ...(ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": ANTHROPIC_WORKSPACE_ID } : {}) });

const db = createClient(SUPABASE_URL, SERVICE_KEY);

type Usuario = { id: string | null; nome: string; papel: "admin" | "cuidador" | "paciente" | "medico"; pessoas: string[] | null; medico_id?: string | null }; // pessoas = null → todas (admin)
const pode = (u: Usuario, pessoaId: string | null | undefined) => u.pessoas === null || (!!pessoaId && u.pessoas.includes(String(pessoaId)));

function normLogin(v: unknown): string {
  return String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/\s+/g, ".").replace(/[^a-z0-9._-]/g, "");
}

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function partesNoFuso(d: Date, fuso: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: fuso, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return { ano: +p.year, mes: +p.month, dia: +p.day, hora: +p.hour === 24 ? 0 : +p.hour, minuto: +p.minute };
}
function localParaUTC(ano: number, mes: number, dia: number, hora: number, minuto: number, fuso: string): Date {
  const palpite = Date.UTC(ano, mes - 1, dia, hora, minuto);
  const p = partesNoFuso(new Date(palpite), fuso);
  const visto = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto);
  return new Date(palpite - (visto - palpite));
}
function horaNoFuso(d: Date, fuso: string) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: fuso, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}
async function avisarAdmin(mensagem: string) {
  const { data } = await db.from("config").select("valor").eq("chave", "admin_telefone").single();
  const tel = (data?.valor ?? "").replace(/\D/g, "");
  if (!tel) return;
  try { await enviarWhats(tel, mensagem); } catch (e) { console.error("Falha ao avisar admin:", String(e)); }
}
async function avisarGrupo(grupo: string | null | undefined, mensagem: string) {
  const g = (grupo ?? "").trim();
  if (!g) return;
  try { await enviarWhats(g, mensagem); } catch (e) { console.error("Falha ao avisar grupo:", String(e)); }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function resp(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function falha(msg: string): never { throw new Error(msg); }
function digitos(s: unknown) { return String(s ?? "").replace(/\D/g, ""); }
function horaValida(h: string) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(h); }

// mantém os agendamentos de um "dono" (medicação ou pessoa/pressão) iguais à lista de horários enviada
async function sincronizarHorarios(filtro: Record<string, string>, base: Record<string, unknown>, horarios: string[], dias: number[], extras: Record<string, Record<string, unknown>> = {}) {
  const lista = [...new Set(horarios.map((h) => h.trim().slice(0, 5)))];
  for (const h of lista) if (!horaValida(h)) falha(`Horário inválido: ${h}`);
  if (!Array.isArray(dias) || dias.some((d) => d < 0 || d > 6)) falha("Dias da semana inválidos");

  let q = db.from("agendamentos").select("id, horario");
  for (const [k, v] of Object.entries(filtro)) q = q.eq(k, v);
  const { data: atuais, error } = await q;
  if (error) falha("agendamentos: " + error.message);

  const existentes = new Map((atuais ?? []).map((a) => [String(a.horario).slice(0, 5), a.id]));
  const remover = (atuais ?? []).filter((a) => !lista.includes(String(a.horario).slice(0, 5))).map((a) => a.id);
  if (remover.length) {
    const { error: e } = await db.from("agendamentos").delete().in("id", remover);
    if (e) falha("remover horários: " + e.message);
  }
  for (const h of lista) {
    if (existentes.has(h)) {
      const { error: e } = await db.from("agendamentos").update({ dias_semana: dias, ativo: true, ...(extras[h] ?? {}) }).eq("id", existentes.get(h)!);
      if (e) falha("atualizar horário: " + e.message);
    } else {
      const { error: e } = await db.from("agendamentos").insert({ ...base, ...filtro, horario: h, dias_semana: dias, ativo: true, ...(extras[h] ?? {}) });
      if (e) falha("inserir horário: " + e.message);
    }
  }
}

async function enviarWhats(telefone: string, mensagem: string) {
  if (!ZAPI_INSTANCE || !ZAPI_TOKEN || !ZAPI_CLIENT_TOKEN) falha("Segredos da Z-API não configurados");
  const r = await fetch(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Client-Token": ZAPI_CLIENT_TOKEN },
    body: JSON.stringify({ phone: telefone, message: mensagem }),
  });
  const t = await r.text();
  if (!r.ok) falha(`Z-API HTTP ${r.status}: ${t.slice(0, 300)}`);
  return t;
}

let _resendChave = "";
async function chaveResend(): Promise<string> {
  if (RESEND_API_KEY) return RESEND_API_KEY;
  if (_resendChave) return _resendChave;
  try {
    const postgres = (await import("npm:postgres@3.4.5")).default;
    const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 5 });
    const [s] = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'resend_api_key'`;
    await sql.end({ timeout: 3 });
    _resendChave = s?.decrypted_secret ? String(s.decrypted_secret) : "";
  } catch (e) { console.error("cofre resend:", String(e).slice(0, 200)); }
  return _resendChave;
}
async function enviarEmail(para: string, assunto: string, html: string) {
  const chave = await chaveResend();
  if (!chave) falha("Serviço de e-mail não configurado (chave do Resend ausente)");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${chave}` },
    body: JSON.stringify({ from: RESEND_FROM, to: [para], subject: assunto, html }),
  });
  const t = await r.text();
  if (!r.ok) falha(`Falha no envio do e-mail (HTTP ${r.status}): ${t.slice(0, 200)}`);
}
function normEmail(v: unknown): string {
  const e = String(v ?? "").trim().toLowerCase();
  if (!e) return "";
  if (e.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) falha("E-mail inválido");
  return e;
}
function escHtml(s: string) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c)); }

// ---------- ações ----------
const acoes: Record<string, (d: Record<string, unknown>, u: Usuario) => Promise<unknown>> = {
  async ping(_d, u) { return { ok: true, usuario: u }; },

  async config_ler(_d, u) {
    if (u.papel !== "admin") return { reenvio_minutos: "30" };
    const { data, error } = await db.from("config").select("chave, valor");
    if (error) falha(error.message);
    return Object.fromEntries((data ?? []).map((c) => [c.chave, c.valor]));
  },
  async config_salvar(d) {
    const admin = digitos(d.admin_telefone);
    const reenvio = Math.max(5, Math.min(240, Number(d.reenvio_minutos) || 30));
    const { error } = await db.from("config").upsert([
      { chave: "admin_telefone", valor: admin },
      { chave: "reenvio_minutos", valor: String(reenvio) },
    ]);
    if (error) falha(error.message);
    return { ok: true };
  },

  async pessoas_listar(_d, u) {
    let qp = db.from("pessoas")
      .select("*, medicacoes(*, agendamentos(id, horario, dias_semana, ativo)), agendamentos(id, tipo, horario, dias_semana, ativo, contexto)")
      .order("nome");
    if (u.pessoas !== null) qp = qp.in("id", u.pessoas.length ? u.pessoas : ["00000000-0000-0000-0000-000000000000"]);
    const { data: pessoas, error } = await qp;
    if (error) falha(error.message);
    const ids = new Set((pessoas ?? []).map((p) => p.id));
    const so = <T extends { pessoa_id: string }>(arr: T[] | null) => (arr ?? []).filter((x) => ids.has(x.pessoa_id));
    const desde = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: leituras, error: e2 } = await db.from("leituras_pa").select("pessoa_id, sistolica, diastolica, pulso, medido_em, fora_faixa").gte("medido_em", desde).order("medido_em", { ascending: false });
    if (e2) falha(e2.message);
    const { data: envios, error: e3 } = await db.from("envios").select("id, pessoa_id, tipo, status, previsto_em, agendamento_id, respondido_em, confirmado_por, origem_confirmacao, observacao").gte("previsto_em", desde);
    if (e3) falha(e3.message);
    const { data: consultas, error: e4 } = await db.from("consultas").select("*").eq("status", "agendada").gte("data_hora", new Date(Date.now() - 86400000).toISOString()).order("data_hora");
    if (e4) falha(e4.message);
    const desde2 = new Date(Date.now() - 2 * 86400000).toISOString();
    const { data: agua, error: e5 } = await db.from("agua_registros").select("pessoa_id, ml, registrado_em").gte("registrado_em", desde2);
    if (e5) falha(e5.message);
    const { data: medidas, error: e6 } = await db.from("medidas").select("*").order("medido_em", { ascending: false }).limit(500);
    if (e6) falha(e6.message);
    const { data: sinais, error: e7 } = await db.from("sinais").select("*").gte("medido_em", desde).order("medido_em", { ascending: false });
    if (e7) falha(e7.message);
    return { pessoas, leituras_7d: so(leituras), envios_7d: so(envios), consultas_futuras: so(consultas), agua_48h: so(agua), medidas: so(medidas), sinais_7d: so(sinais) };
  },
  async pessoa_salvar(d, u) {
    if (!d.id && u.papel !== "admin") falha("Só o administrador cadastra pacientes novos");
    const nome = String(d.nome ?? "").trim();
    const telefone = digitos(d.telefone);
    if (!nome) falha("Nome obrigatório");
    if (telefone.length < 10 || telefone.length > 15) falha("Telefone inválido (use DDI+DDD+número, só dígitos)");
    const linha = {
      nome, telefone, fuso: String(d.fuso || "America/Fortaleza"), ativa: d.ativa !== false,
      pa_sis_max: Number(d.pa_sis_max) || 140, pa_dia_max: Number(d.pa_dia_max) || 90,
      agua_meta_ml: Math.max(500, Math.min(6000, Number(d.agua_meta_ml) || 2000)),
      grupo_whats: d.grupo_whats ? String(d.grupo_whats).trim() : null,
      grupo_nivel: d.grupo_nivel === "tudo" ? "tudo" : "alertas",
      gli_min: Number(d.gli_min) || 70, gli_max: Number(d.gli_max) || 180,
      spo2_min: Number(d.spo2_min) || 92, bpm_min: Number(d.bpm_min) || 50, bpm_max: Number(d.bpm_max) || 110,
      peso_var_kg: Number(String(d.peso_var_kg ?? "2").replace(",", ".")) || 2,
      ...(d.comorbidades !== undefined ? { comorbidades: Array.isArray(d.comorbidades) ? (d.comorbidades as unknown[]).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 40) : null } : {}),
      observacoes: d.observacoes ? String(d.observacoes) : null,
    };
    const q = d.id ? db.from("pessoas").update(linha).eq("id", String(d.id)) : db.from("pessoas").insert(linha);
    const { data, error } = await q.select().single();
    if (error) falha(error.message.includes("pessoas_telefone_key") ? "Já existe uma pessoa com esse telefone" : error.message);
    return data;
  },
  async pessoa_excluir(d) {
    if (!d.id) falha("id obrigatório");
    const { error } = await db.from("pessoas").delete().eq("id", String(d.id));
    if (error) falha(error.message);
    return { ok: true };
  },

  async medicacao_salvar(d, u) {
    const nome = String(d.nome ?? "").trim();
    if (!nome) falha("Nome do remédio obrigatório");
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const horarios = Array.isArray(d.horarios) ? (d.horarios as string[]) : [];
    if (horarios.length === 0) falha("Informe pelo menos um horário");
    const uso = d.uso === "periodo" ? "periodo" : "continuo";
    let inicio: string | null = null, nDias: number | null = null, fim: string | null = null;
    if (uso === "periodo") {
      inicio = String(d.inicio ?? "");
      nDias = Number(d.dias);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio)) falha("Informe a data de início do período");
      if (!(nDias >= 1 && nDias <= 365)) falha("Dias do período: 1 a 365");
      const f = new Date(inicio + "T12:00:00Z"); f.setUTCDate(f.getUTCDate() + nDias - 1);
      fim = f.toISOString().slice(0, 10);
    }
    const linha = { pessoa_id: String(d.pessoa_id), nome, dose: d.dose ? String(d.dose) : null, observacao: d.observacao ? String(d.observacao) : null, ativa: d.ativa !== false, uso, inicio, dias: nDias, fim,
      posologia: d.posologia ? String(d.posologia) : null, medico_id: d.medico_id ? String(d.medico_id) : null, ...(d.receita_id ? { receita_id: String(d.receita_id) } : {}) };
    const q = d.id ? db.from("medicacoes").update(linha).eq("id", String(d.id)) : db.from("medicacoes").insert({ ...linha, criado_por: u.nome });
    const { data: med, error } = await q.select().single();
    if (error) falha(error.message);
    const dias = Array.isArray(d.dias_semana) ? (d.dias_semana as number[]) : [0, 1, 2, 3, 4, 5, 6];
    await sincronizarHorarios({ medicacao_id: med.id }, { pessoa_id: med.pessoa_id, tipo: "medicacao" }, horarios, dias);
    return med;
  },
  async medicacao_excluir(d) {
    if (!d.id) falha("id obrigatório");
    const { error } = await db.from("medicacoes").delete().eq("id", String(d.id));
    if (error) falha(error.message);
    return { ok: true };
  },

  async pressao_horarios_salvar(d) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const horarios = Array.isArray(d.horarios) ? (d.horarios as string[]) : [];
    const dias = Array.isArray(d.dias_semana) ? (d.dias_semana as number[]) : [0, 1, 2, 3, 4, 5, 6];
    await sincronizarHorarios({ pessoa_id: String(d.pessoa_id), tipo: "pressao" }, {}, horarios, dias);
    return { ok: true };
  },

  async leituras_listar(d) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    let q = db.from("leituras_pa").select("*").eq("pessoa_id", String(d.pessoa_id)).order("medido_em", { ascending: false });
    if (d.de) q = q.gte("medido_em", String(d.de));
    if (d.ate) q = q.lte("medido_em", String(d.ate));
    const { data, error } = await q.limit(1000);
    if (error) falha(error.message);
    return data;
  },
  async leitura_inserir(d, u) {
    const sis = Number(d.sistolica), dia = Number(d.diastolica);
    if (!(sis >= 50 && sis <= 300 && dia >= 30 && dia <= 200 && sis > dia)) falha("Valores de pressão inválidos");
    const { data: p, error: ep } = await db.from("pessoas").select("pa_sis_max, pa_dia_max").eq("id", String(d.pessoa_id)).single();
    if (ep) falha(ep.message);
    const { data, error } = await db.from("leituras_pa").insert({
      pessoa_id: String(d.pessoa_id), sistolica: sis, diastolica: dia, pulso: d.pulso ? Number(d.pulso) : null,
      medido_em: d.medido_em ? new Date(String(d.medido_em)).toISOString() : new Date().toISOString(),
      origem: "manual", fora_faixa: sis >= p.pa_sis_max || dia >= p.pa_dia_max, informado_por: u.nome,
    }).select().single();
    if (error) falha(error.message);
    return data;
  },
  async leitura_excluir(d) {
    if (!d.id) falha("id obrigatório");
    const { error } = await db.from("leituras_pa").delete().eq("id", String(d.id));
    if (error) falha(error.message);
    return { ok: true };
  },

  async envios_listar(d) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    let q = db.from("envios").select("*, agendamentos(horario, medicacoes(nome, dose))").eq("pessoa_id", String(d.pessoa_id)).order("previsto_em", { ascending: false });
    if (d.de) q = q.gte("previsto_em", String(d.de));
    if (d.ate) q = q.lte("previsto_em", String(d.ate));
    const { data, error } = await q.limit(2000);
    if (error) falha(error.message);
    return data;
  },

  async mensagens_listar(d) {
    let q = db.from("mensagens_recebidas").select("id, telefone, pessoa_id, texto, interpretado_como, recebido_em").order("recebido_em", { ascending: false }).limit(200);
    if (d.pessoa_id) q = q.eq("pessoa_id", String(d.pessoa_id));
    const { data, error } = await q;
    if (error) falha(error.message);
    return data;
  },

  // ---------- consultas ----------
  async consultas_listar(d) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const { data, error } = await db.from("consultas").select("*").eq("pessoa_id", String(d.pessoa_id)).order("data_hora", { ascending: false }).limit(500);
    if (error) falha(error.message);
    return data;
  },
  async consulta_salvar(d, u) {
    const descricao = String(d.descricao ?? "").trim();
    if (!descricao) falha("Descrição obrigatória");
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    if (!d.data_hora) falha("Data e hora obrigatórias");
    const ants = (Array.isArray(d.antecedencias) ? d.antecedencias : [1440, 180]).map(Number).filter((n) => n >= 15 && n <= 43200);
    const linha = {
      pessoa_id: String(d.pessoa_id), tipo: d.tipo === "retorno" ? "retorno" : "consulta",
      consulta_origem_id: d.consulta_origem_id ? String(d.consulta_origem_id) : null,
      descricao, local: d.local ? String(d.local) : null,
      data_hora: new Date(String(d.data_hora)).toISOString(),
      antecedencias: ants.length ? ants : [1440, 180],
      avisar_paciente: d.avisar_paciente !== false, avisar_admin: d.avisar_admin !== false,
      status: ["agendada", "realizada", "cancelada"].includes(String(d.status)) ? String(d.status) : "agendada",
      observacoes: d.observacoes ? String(d.observacoes) : null,
      medico_id: d.medico_id ? String(d.medico_id) : null,
    };
    const q = d.id ? db.from("consultas").update(linha).eq("id", String(d.id)) : db.from("consultas").insert({ ...linha, criado_por: u.nome });
    const { data, error } = await q.select().single();
    if (error) falha(error.message);
    if (d.id) { const { error: eA } = await db.from("consulta_avisos").delete().eq("consulta_id", String(d.id)); if (eA) falha(eA.message); }
    return data;
  },
  async consulta_excluir(d) {
    if (!d.id) falha("id obrigatório");
    const { error } = await db.from("consultas").delete().eq("id", String(d.id));
    if (error) falha(error.message);
    return { ok: true };
  },

  // ---------- documentos ----------
  async documento_upload_url(d) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const nome = String(d.nome_arquivo || "arquivo").replace(/[^\w.\-]+/g, "_").slice(-80);
    const caminho = `${String(d.pessoa_id)}/${Date.now()}_${nome}`;
    const { data, error } = await db.storage.from("documentos").createSignedUploadUrl(caminho);
    if (error) falha("upload_url: " + error.message);
    return { caminho, url: data.signedUrl, token: data.token };
  },
  async documento_salvar(d, u) {
    if (!d.pessoa_id || !d.caminho) falha("pessoa_id e caminho obrigatórios");
    const titulo = String(d.titulo ?? "").trim();
    if (!titulo) falha("Título obrigatório");
    const categoria = ["carteirinha", "identidade", "guia", "laudo", "receita", "outro"].includes(String(d.categoria)) ? String(d.categoria) : "outro";
    const { data, error } = await db.from("documentos").insert({
      pessoa_id: String(d.pessoa_id), categoria, titulo, caminho: String(d.caminho),
      mime: d.mime ? String(d.mime) : null, tamanho: d.tamanho ? Number(d.tamanho) : null,
      data_documento: d.data_documento ? String(d.data_documento) : null,
      enviado_por: u.nome,
    }).select().single();
    if (error) falha(error.message);
    return data;
  },
  async documentos_listar(d) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const { data, error } = await db.from("documentos").select("*").eq("pessoa_id", String(d.pessoa_id)).order("criado_em", { ascending: false });
    if (error) falha(error.message);
    return data;
  },
  async documento_baixar(d) {
    if (!d.id) falha("id obrigatório");
    const { data: doc, error } = await db.from("documentos").select("caminho").eq("id", String(d.id)).single();
    if (error) falha(error.message);
    const { data, error: e2 } = await db.storage.from("documentos").createSignedUrl(doc.caminho, 3600);
    if (e2) falha("link: " + e2.message);
    return { url: data.signedUrl };
  },
  async documento_excluir(d) {
    if (!d.id) falha("id obrigatório");
    const { data: doc, error } = await db.from("documentos").select("caminho").eq("id", String(d.id)).single();
    if (error) falha(error.message);
    const { error: eS } = await db.storage.from("documentos").remove([doc.caminho]);
    if (eS) falha("storage: " + eS.message);
    const { error: e2 } = await db.from("documentos").delete().eq("id", String(d.id));
    if (e2) falha(e2.message);
    return { ok: true };
  },

  // ---------- medidas ----------
  async medida_inserir(d, u) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const peso = d.peso_kg ? Number(String(d.peso_kg).replace(",", ".")) : null;
    const altura = d.altura_cm ? Number(String(d.altura_cm).replace(",", ".")) : null;
    if (!peso && !altura) falha("Informe peso e/ou altura");
    if (peso && !(peso >= 1 && peso <= 500)) falha("Peso inválido");
    if (altura && !(altura >= 30 && altura <= 250)) falha("Altura inválida (em cm)");
    const { data, error } = await db.from("medidas").insert({
      pessoa_id: String(d.pessoa_id), peso_kg: peso, altura_cm: altura, informado_por: u.nome,
      medido_em: d.medido_em ? new Date(String(d.medido_em)).toISOString() : new Date().toISOString(),
    }).select().single();
    if (error) falha(error.message);
    return data;
  },
  async medidas_listar(d) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const { data, error } = await db.from("medidas").select("*").eq("pessoa_id", String(d.pessoa_id)).order("medido_em", { ascending: false }).limit(500);
    if (error) falha(error.message);
    return data;
  },
  async medida_excluir(d) {
    if (!d.id) falha("id obrigatório");
    const { error } = await db.from("medidas").delete().eq("id", String(d.id));
    if (error) falha(error.message);
    return { ok: true };
  },

  // ---------- água ----------
  async agua_horarios_salvar(d) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const horarios = Array.isArray(d.horarios) ? (d.horarios as string[]) : [];
    const dias = Array.isArray(d.dias_semana) ? (d.dias_semana as number[]) : [0, 1, 2, 3, 4, 5, 6];
    await sincronizarHorarios({ pessoa_id: String(d.pessoa_id), tipo: "agua" }, {}, horarios, dias);
    return { ok: true };
  },
  async agua_listar(d) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    let q = db.from("agua_registros").select("*").eq("pessoa_id", String(d.pessoa_id)).order("registrado_em", { ascending: false });
    if (d.de) q = q.gte("registrado_em", String(d.de));
    if (d.ate) q = q.lte("registrado_em", String(d.ate));
    const { data, error } = await q.limit(2000);
    if (error) falha(error.message);
    return data;
  },
  async agua_inserir(d, u) {
    const ml = Number(d.ml);
    if (!(ml >= 10 && ml <= 5000)) falha("Quantidade inválida (10 a 5000 ml)");
    const { data, error } = await db.from("agua_registros").insert({
      pessoa_id: String(d.pessoa_id), ml, origem: "manual", informado_por: u.nome,
      registrado_em: d.registrado_em ? new Date(String(d.registrado_em)).toISOString() : new Date().toISOString(),
    }).select().single();
    if (error) falha(error.message);
    return data;
  },
  async agua_excluir(d) {
    if (!d.id) falha("id obrigatório");
    const { error } = await db.from("agua_registros").delete().eq("id", String(d.id));
    if (error) falha(error.message);
    return { ok: true };
  },

  async grupos_listar() {
    if (!ZAPI_INSTANCE || !ZAPI_TOKEN || !ZAPI_CLIENT_TOKEN) falha("Segredos da Z-API não configurados");
    const r = await fetch(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/groups?page=1&pageSize=200`, {
      headers: { "Client-Token": ZAPI_CLIENT_TOKEN },
    });
    const t = await r.text();
    if (!r.ok) falha(`Z-API HTTP ${r.status}: ${t.slice(0, 300)}`);
    let lista: unknown;
    try { lista = JSON.parse(t); } catch { falha("Resposta da Z-API não é JSON: " + t.slice(0, 200)); }
    const arr = Array.isArray(lista) ? lista : (lista as { groups?: unknown[] })?.groups ?? [];
    return (arr as Record<string, unknown>[]).map((g) => ({
      id: String(g.phone ?? g.id ?? ""),
      nome: String(g.name ?? g.subject ?? g.phone ?? "grupo sem nome"),
    })).filter((g) => g.id);
  },

  // ---------- usuários (só admin) ----------
  async usuarios_listar(_d, u) {
    if (u.papel !== "admin") falha("Só o administrador gerencia usuários");
    const { data, error } = await db.from("usuarios").select("id, nome, papel, ativo, criado_em, medico_id, login, email, relacao").order("nome");
    if (error) falha(error.message);
    const { data: vinc, error: e2 } = await db.from("usuarios_pessoas").select("usuario_id, pessoa_id");
    if (e2) falha(e2.message);
    return (data ?? []).map((x) => ({ ...x, pessoa_ids: (vinc ?? []).filter((v) => v.usuario_id === x.id).map((v) => v.pessoa_id) }));
  },
  async usuario_salvar(d, u) {
    if (u.papel !== "admin") falha("Só o administrador gerencia usuários");
    const nome = String(d.nome ?? "").trim();
    if (!nome) falha("Nome obrigatório");
    const papel = ["admin", "cuidador", "paciente", "medico"].includes(String(d.papel)) ? String(d.papel) : "cuidador";
    const pessoaIds = (Array.isArray(d.pessoa_ids) ? d.pessoa_ids : []).map(String).filter(Boolean);
    if (papel === "paciente" && pessoaIds.length !== 1) falha("Um usuário paciente deve estar vinculado a exatamente um paciente");
    if (papel === "cuidador" && pessoaIds.length === 0) falha("Vincule o cuidador a pelo menos um paciente"); // médico pode começar sem vínculos (recebe pelos convites)
    const login = normLogin(d.login);
    if (!d.id && !login) falha("Defina o nome de usuário (para entrar no painel)");
    if (login === "admin") falha("O usuário admin é reservado ao administrador");
    if (login && login.length < 3) falha("Usuário com pelo menos 3 caracteres (letras, números, ponto)");
    const linha: Record<string, unknown> = { nome, papel, ativo: d.ativo !== false };
    if (login) linha.login = login;
    if (d.email !== undefined) linha.email = normEmail(d.email) || null;
    if (d.relacao !== undefined) linha.relacao = d.relacao ? String(d.relacao).trim().slice(0, 40) : null;
    const senha = String(d.senha_nova ?? "");
    if (senha) {
      if (senha.length < 6) falha("Senha com pelo menos 6 caracteres");
      linha.senha_hash = await sha256(senha);
    } else if (!d.id) falha("Senha obrigatória para novo usuário");
    const q = d.id ? db.from("usuarios").update(linha).eq("id", String(d.id)) : db.from("usuarios").insert(linha);
    const { data, error } = await q.select("id, nome, papel, ativo, medico_id, login, email, relacao").single();
    if (error) falha(String(error.message).includes("duplicate") || String(error.message).includes("idx_usuarios_login") ? `O usuário "${login}" já existe — escolha outro` : error.message);
    const { error: eDel } = await db.from("usuarios_pessoas").delete().eq("usuario_id", data.id);
    if (eDel) falha(eDel.message);
    if (papel !== "admin" && pessoaIds.length) {
      const { error: eIns } = await db.from("usuarios_pessoas").insert(pessoaIds.map((pid) => ({ usuario_id: data.id, pessoa_id: pid })));
      if (eIns) falha(eIns.message);
    }
    return { ...data, pessoa_ids: papel === "admin" ? [] : pessoaIds };
  },
  async usuario_excluir(d, u) {
    if (u.papel !== "admin") falha("Só o administrador gerencia usuários");
    const { error } = await db.from("usuarios").delete().eq("id", String(d.id));
    if (error) falha(error.message);
    return { ok: true };
  },

  // ---------- marcação manual de tomada ----------
  async tomada_marcar(d, u) {
    if (!d.agendamento_id || !d.data || !d.hora) falha("agendamento_id, data e hora obrigatórios");
    const { data: ag, error } = await db.from("agendamentos").select("id, pessoa_id, horario, tipo, pessoas(fuso)").eq("id", String(d.agendamento_id)).single();
    if (error) falha(error.message);
    const fuso = (ag.pessoas as unknown as { fuso: string }).fuso;
    const [ano, mes, dia] = String(d.data).split("-").map(Number);
    const [hh, mm] = String(ag.horario).split(":").map(Number);
    const [rh, rm] = String(d.hora).split(":").map(Number);
    if (![ano, mes, dia, hh, mm, rh, rm].every((n) => Number.isFinite(n))) falha("Data ou hora inválida");
    const previsto = localParaUTC(ano, mes, dia, hh, mm, fuso).toISOString();
    const respondido = localParaUTC(ano, mes, dia, rh, rm, fuso).toISOString();
    const { data: existente } = await db.from("envios").select("id").eq("agendamento_id", ag.id).eq("previsto_em", previsto).maybeSingle();
    const campos = { status: "confirmado", respondido_em: respondido, confirmado_por: u.nome, origem_confirmacao: "painel", observacao: d.observacao ? String(d.observacao) : null };
    if (existente) {
      const { error: e2 } = await db.from("envios").update(campos).eq("id", existente.id);
      if (e2) falha(e2.message);
      return { id: existente.id };
    }
    const { data: novo, error: e3 } = await db.from("envios").insert({ pessoa_id: ag.pessoa_id, agendamento_id: ag.id, tipo: ag.tipo, previsto_em: previsto, ...campos }).select("id").single();
    if (e3) falha(e3.message);
    return { id: novo.id };
  },
  async tomada_desfazer(d) {
    if (!d.id) falha("id obrigatório");
    const { data: e, error } = await db.from("envios").select("id, enviado_em").eq("id", String(d.id)).single();
    if (error) falha(error.message);
    if (!e.enviado_em) { const { error: eD } = await db.from("envios").delete().eq("id", e.id); if (eD) falha(eD.message); }
    else { const { error: eU } = await db.from("envios").update({ status: "sem_resposta", respondido_em: null, confirmado_por: null, origem_confirmacao: null, observacao: null }).eq("id", e.id); if (eU) falha(eU.message); }
    return { ok: true };
  },

  // ---------- glicemia / oximetria / peso: horários e lançamentos ----------
  async sinal_horarios_salvar(d) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const tipo = String(d.tipo);
    if (!["glicemia", "oximetria", "peso"].includes(tipo)) falha("Tipo inválido");
    const horarios = Array.isArray(d.horarios) ? (d.horarios as string[]) : [];
    const dias = Array.isArray(d.dias_semana) ? (d.dias_semana as number[]) : [0, 1, 2, 3, 4, 5, 6];
    const extras: Record<string, Record<string, unknown>> = {};
    if (tipo === "glicemia") {
      const ctx = (d.contextos ?? {}) as Record<string, string>;
      for (const h of horarios) extras[h.slice(0, 5)] = { contexto: ["jejum", "pos_refeicao", "outro"].includes(ctx[h]) ? ctx[h] : "outro" };
    }
    await sincronizarHorarios({ pessoa_id: String(d.pessoa_id), tipo }, {}, horarios, dias, extras);
    return { ok: true };
  },
  async sinais_listar(d) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    let q = db.from("sinais").select("*").eq("pessoa_id", String(d.pessoa_id)).order("medido_em", { ascending: false });
    if (d.tipo) q = q.eq("tipo", String(d.tipo));
    if (d.de) q = q.gte("medido_em", String(d.de));
    if (d.ate) q = q.lte("medido_em", String(d.ate));
    const { data, error } = await q.limit(2000);
    if (error) falha(error.message);
    return data;
  },
  async sinal_inserir(d, u) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const tipo = String(d.tipo);
    const { data: p, error: ep } = await db.from("pessoas").select("gli_min, gli_max, spo2_min, bpm_min, bpm_max").eq("id", String(d.pessoa_id)).single();
    if (ep) falha(ep.message);
    const linha: Record<string, unknown> = { pessoa_id: String(d.pessoa_id), tipo, origem: "manual", informado_por: u.nome,
      medido_em: d.medido_em ? new Date(String(d.medido_em)).toISOString() : new Date().toISOString() };
    if (tipo === "glicemia") {
      const g = Number(d.glicemia);
      if (!(g >= 20 && g <= 600)) falha("Glicemia inválida (20 a 600)");
      linha.glicemia = g; linha.contexto = ["jejum", "pos_refeicao", "outro"].includes(String(d.contexto)) ? String(d.contexto) : "outro";
      linha.fora_faixa = g < p.gli_min || g > p.gli_max;
    } else if (tipo === "oximetria") {
      const s = d.spo2 ? Number(d.spo2) : null, b = d.bpm ? Number(d.bpm) : null;
      if (s === null && b === null) falha("Informe SpO₂ e/ou bpm");
      if (s !== null && !(s >= 50 && s <= 100)) falha("SpO₂ inválida (50 a 100)");
      if (b !== null && !(b >= 20 && b <= 250)) falha("bpm inválido (20 a 250)");
      linha.spo2 = s; linha.bpm = b;
      linha.fora_faixa = (s !== null && s < p.spo2_min) || (b !== null && (b < p.bpm_min || b > p.bpm_max));
    } else falha("Tipo inválido");
    const { data, error } = await db.from("sinais").insert(linha).select().single();
    if (error) falha(error.message);
    return data;
  },
  async sinal_excluir(d) {
    if (!d.id) falha("id obrigatório");
    const { error } = await db.from("sinais").delete().eq("id", String(d.id));
    if (error) falha(error.message);
    return { ok: true };
  },

  // ---------- remédios de uso eventual ----------
  async eventuais_listar(d) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const { data: meds, error } = await db.from("medicamentos_eventuais").select("*").eq("pessoa_id", String(d.pessoa_id)).order("nome");
    if (error) falha(error.message);
    const desde = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: usos, error: e2 } = await db.from("usos_eventuais").select("*").eq("pessoa_id", String(d.pessoa_id)).gte("tomado_em", desde).order("tomado_em", { ascending: false });
    if (e2) falha(e2.message);
    return { medicamentos: meds, usos_30d: usos };
  },
  async eventual_salvar(d, u) {
    const nome = String(d.nome ?? "").trim(), indicacao = String(d.indicacao ?? "").trim();
    if (!nome || !indicacao) falha("Nome e indicação obrigatórios");
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const linha = { pessoa_id: String(d.pessoa_id), nome, dose: d.dose ? String(d.dose) : null, indicacao,
      intervalo_min_h: d.intervalo_min_h ? Number(String(d.intervalo_min_h).replace(",", ".")) : null,
      max_dia: d.max_dia ? Number(d.max_dia) : null, instrucoes: d.instrucoes ? String(d.instrucoes) : null,
      urgencia: d.urgencia === true, ativo: d.ativo !== false, posologia: d.posologia ? String(d.posologia) : null, medico_id: d.medico_id ? String(d.medico_id) : null, ...(d.receita_id ? { receita_id: String(d.receita_id) } : {}) };
    const q = d.id ? db.from("medicamentos_eventuais").update(linha).eq("id", String(d.id)) : db.from("medicamentos_eventuais").insert({ ...linha, criado_por: u.nome });
    const { data, error } = await q.select().single();
    if (error) falha(error.message);
    return data;
  },
  async eventual_excluir(d) {
    if (!d.id) falha("id obrigatório");
    const { error } = await db.from("medicamentos_eventuais").delete().eq("id", String(d.id));
    if (error) falha(error.message);
    return { ok: true };
  },
  async uso_eventual_registrar(d, u) {
    if (!d.medicamento_id) falha("medicamento_id obrigatório");
    const { data: m, error } = await db.from("medicamentos_eventuais").select("*, pessoas(nome, fuso, grupo_whats)").eq("id", String(d.medicamento_id)).single();
    if (error) falha(error.message);
    const p = m.pessoas as unknown as { nome: string; fuso: string; grupo_whats: string | null };
    const quando = d.tomado_em ? new Date(String(d.tomado_em)) : new Date();
    const avisos: string[] = [];
    const { data: ultimos } = await db.from("usos_eventuais").select("tomado_em").eq("medicamento_id", m.id).gte("tomado_em", new Date(quando.getTime() - 48 * 3600000).toISOString()).order("tomado_em", { ascending: false });
    const ult = ultimos?.[0]?.tomado_em ? new Date(ultimos[0].tomado_em) : null;
    if (m.intervalo_min_h && ult) {
      const horas = (quando.getTime() - ult.getTime()) / 3600000;
      if (horas < m.intervalo_min_h) avisos.push(`Intervalo mínimo de ${m.intervalo_min_h}h não respeitado (última dose há ${horas.toFixed(1)}h).`);
    }
    if (m.max_dia) {
      const pf = partesNoFuso(quando, p.fuso);
      const inicioDia = localParaUTC(pf.ano, pf.mes, pf.dia, 0, 0, p.fuso).toISOString();
      const hoje = (ultimos ?? []).filter((x) => x.tomado_em >= inicioDia).length;
      if (hoje + 1 > m.max_dia) avisos.push(`Máximo de ${m.max_dia} dose(s) por dia ultrapassado (esta é a ${hoje + 1}ª).`);
    }
    const { data: uso, error: e2 } = await db.from("usos_eventuais").insert({ pessoa_id: m.pessoa_id, medicamento_id: m.id, tomado_em: quando.toISOString(), origem: "painel", informado_por: u.nome, observacao: d.observacao ? String(d.observacao) : null }).select().single();
    if (e2) falha(e2.message);
    if (m.urgencia || avisos.length) {
      const txt = `${m.urgencia ? "🚨 URGÊNCIA — " : "⚠️ "}${p.nome} usou ${m.nome}${m.dose ? " " + m.dose : ""} às ${horaNoFuso(quando, p.fuso)} (informado por ${u.nome}).${avisos.length ? " " + avisos.join(" ") : ""}`;
      await avisarAdmin(txt); await avisarGrupo(p.grupo_whats, txt);
    }
    return { uso, avisos };
  },
  async uso_eventual_excluir(d) {
    if (!d.id) falha("id obrigatório");
    const { error } = await db.from("usos_eventuais").delete().eq("id", String(d.id));
    if (error) falha(error.message);
    return { ok: true };
  },

  // ---------- histórico de saúde ----------
  async historico_salvar(d, u) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const { error } = await db.from("pessoas").update({ historico_saude: d.texto ? String(d.texto) : null, historico_por: u.nome, historico_em: new Date().toISOString() }).eq("id", String(d.pessoa_id));
    if (error) falha(error.message);
    return { ok: true };
  },

  // ---------- anamnese ----------
  async anamnese_ler(d) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const { data, error } = await db.from("anamneses").select("*").eq("pessoa_id", String(d.pessoa_id)).order("versao", { ascending: false });
    if (error) falha(error.message);
    return { atual: data?.[0] ?? null, versoes: (data ?? []).map((a) => ({ id: a.id, versao: a.versao, concluida: a.concluida, preenchido_por: a.preenchido_por, atualizado_em: a.atualizado_em })) };
  },
  async anamnese_versao_ler(d) {
    if (!d.id) falha("id obrigatório");
    const { data, error } = await db.from("anamneses").select("*").eq("id", String(d.id)).single();
    if (error) falha(error.message);
    return data;
  },
  async anamnese_salvar(d, u) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const respostas = (d.respostas && typeof d.respostas === "object") ? d.respostas : {};
    const campos = { respostas, concluida: d.concluida === true, resumo_auto: d.resumo_auto ? String(d.resumo_auto) : null,
      alertas: Array.isArray(d.alertas) ? (d.alertas as string[]).map(String).slice(0, 50) : [],
      comorbidades: Array.isArray(d.comorbidades) ? (d.comorbidades as string[]).map(String).slice(0, 40) : [], preenchido_por: u.nome, atualizado_em: new Date().toISOString() };
    if (d.id && d.nova_versao !== true) {
      const { data, error } = await db.from("anamneses").update(campos).eq("id", String(d.id)).select().single();
      if (error) falha(error.message);
      return data;
    }
    const { data: ult } = await db.from("anamneses").select("versao").eq("pessoa_id", String(d.pessoa_id)).order("versao", { ascending: false }).limit(1);
    const versao = (ult?.[0]?.versao ?? 0) + 1;
    const { data, error } = await db.from("anamneses").insert({ pessoa_id: String(d.pessoa_id), versao, ...campos }).select().single();
    if (error) falha(error.message);
    return data;
  },
  async anamnese_resumo_ia_salvar(d) {
    if (!d.id) falha("id obrigatório");
    const { error } = await db.from("anamneses").update({ resumo_ia: d.texto ? String(d.texto) : null, atualizado_em: new Date().toISOString() }).eq("id", String(d.id));
    if (error) falha(error.message);
    return { ok: true };
  },
  async ia_gerar(d) {
    if (!ANTHROPIC_API_KEY) falha("Chave da IA não configurada (segredo ANTHROPIC_API_KEY)");
    const texto = String(d.texto_qa ?? "").slice(0, 60000);
    if (!texto.trim()) falha("Sem respostas para resumir");
    const tipo = d.tipo === "historico" ? "historico" : "resumo";
    const instrucao = tipo === "resumo"
      ? "Você é um médico redigindo o resumo clínico de admissão de um paciente a partir da anamnese abaixo. Escreva em português do Brasil, em prosa objetiva de prontuário (150 a 300 palavras), na ordem: identificação e contexto social; diagnósticos ativos e dispositivos; medicações de risco e alergias (destaque); antecedentes cirúrgicos e familiares relevantes; hábitos; sintomas atuais relevantes e funcionalidade/risco de quedas; pendências de prevenção. Cite apenas o que foi respondido; não invente dados nem faça diagnósticos novos. Termine com uma linha 'Pontos de atenção:' listando de 3 a 6 itens curtos."
      : "A partir da anamnese abaixo, escreva um 'histórico de saúde' curto (80 a 150 palavras) em primeira pessoa, linguagem simples, como o próprio paciente ou seu cuidador contaria: doenças que tem, remédios importantes, alergias, cirurgias e limitações do dia a dia. Português do Brasil. Use apenas o que foi respondido.";
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: cabecalhosIA(),
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 1200, system: instrucao, messages: [{ role: "user", content: texto }] }),
    });
    const j = await r.json();
    if (!r.ok) falha(`IA HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const saida = (j.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n").trim();
    if (!saida) falha("A IA não retornou texto");
    return { texto: saida };
  },

  // ---------- leitura de receita (PDF ou imagem) pela IA ----------
  async receita_ler(d) {
    if (!ANTHROPIC_API_KEY) falha("Chave da IA não configurada (segredo ANTHROPIC_API_KEY)");
    const b64 = String(d.arquivo_base64 ?? "");
    const mime = String(d.mime ?? "application/pdf");
    if (!b64) falha("Arquivo vazio");
    if (b64.length > 12_000_000) falha("Arquivo muito grande para leitura (máx. ~8 MB)");
    const ehPdf = mime === "application/pdf";
    if (!ehPdf && !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime)) falha("Envie PDF ou imagem (JPG/PNG)");
    const hoje = new Date().toISOString().slice(0, 10);
    const instrucao = `Você extrai prescrições de receitas médicas brasileiras. Leia o documento e devolva SOMENTE um JSON válido, sem texto antes ou depois, sem markdown, no formato:
{"profissional":"nome e conselho, se houver","data":"YYYY-MM-DD ou null","itens":[{"nome":"princípio ativo ou nome comercial como escrito","dose":"ex.: 50 mg","posologia":"texto resumido de como usar","tipo":"continuo|periodo|eventual","horarios":["HH:MM"],"dias":null,"indicacao":"só para eventual: quando usar","observacao":"restrições, ex.: em jejum, evitar dirigir"}]}
Regras: tipo "eventual" quando for "se necessário", "em caso de dor/febre", "SOS"; "periodo" quando houver duração definida (ex.: por 7 dias → dias=7); senão "continuo".
Horários a partir da frequência: 1x/dia → ["08:00"] (à noite → ["22:00"]; em jejum → ["06:30"]); 12/12h ou 2x/dia → ["08:00","20:00"]; 8/8h ou 3x/dia → ["06:00","14:00","22:00"]; 6/6h ou 4x/dia → ["06:00","12:00","18:00","00:00"]; após o almoço → ["13:00"]; se a receita der horários explícitos, use-os. Para "eventual", horarios = []. Não invente itens; se um campo não constar, use null ou "". Hoje é ${hoje}.`;
    const conteudo = ehPdf
      ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }, { type: "text", text: "Extraia as prescrições desta receita." }]
      : [{ type: "image", source: { type: "base64", media_type: mime, data: b64 } }, { type: "text", text: "Extraia as prescrições desta receita." }];
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: cabecalhosIA(),
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 4000, system: instrucao, messages: [{ role: "user", content: conteudo }] }),
    });
    const j = await r.json();
    if (!r.ok) falha(`IA HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const saida = (j.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n").trim();
    const limpo = saida.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let dados: { itens?: unknown[] };
    try { dados = JSON.parse(limpo); } catch { falha("A IA não devolveu uma lista válida. Tente uma imagem mais nítida ou o PDF original."); }
    const itens = (Array.isArray(dados.itens) ? dados.itens : []).map((it) => {
      const x = it as Record<string, unknown>;
      const tipo = ["continuo", "periodo", "eventual"].includes(String(x.tipo)) ? String(x.tipo) : "continuo";
      const horarios = (Array.isArray(x.horarios) ? x.horarios : []).map(String).filter((h) => /^([01]\d|2[0-3]):[0-5]\d$/.test(h));
      return { nome: String(x.nome ?? "").trim(), dose: x.dose ? String(x.dose) : "", posologia: x.posologia ? String(x.posologia) : "", tipo,
        horarios: tipo === "eventual" ? [] : (horarios.length ? horarios : ["08:00"]), dias: tipo === "periodo" ? (Number(x.dias) || null) : null,
        indicacao: x.indicacao ? String(x.indicacao) : "", observacao: x.observacao ? String(x.observacao) : "" };
    }).filter((it) => it.nome);
    if (!itens.length) falha("Nenhum medicamento reconhecido na receita.");
    return { profissional: (dados as Record<string, unknown>).profissional ?? "", data: (dados as Record<string, unknown>).data ?? null, itens };
  },

  // ---------- médicos (cadastro compartilhado) ----------
  async medicos_listar() {
    const { data, error } = await db.from("medicos").select("*").order("nome");
    if (error) falha(error.message);
    return data;
  },
  async medico_salvar(d, u) {
    if (u.papel === "paciente") falha("Seu perfil não cadastra médicos");
    const nome = String(d.nome ?? "").trim();
    if (!nome) falha("Nome obrigatório");
    const linha = {
      nome, especialidade: d.especialidade ? String(d.especialidade).trim() : null,
      crm: d.crm ? String(d.crm).trim() : null, crm_uf: d.crm_uf ? String(d.crm_uf).trim().toUpperCase().slice(0, 2) : null,
      telefone_consultorio: d.telefone_consultorio ? String(d.telefone_consultorio).trim() : null,
      whatsapp: d.whatsapp ? digitos(d.whatsapp) : null, secretaria: d.secretaria ? String(d.secretaria).trim() : null,
      atende_convenio: d.atende_convenio === true, convenios: d.convenios ? String(d.convenios).trim() : null,
      atende_particular: d.atende_particular === true,
      valor_particular: d.valor_particular ? Number(String(d.valor_particular).replace(/[^\d,.]/g, "").replace(",", ".")) || null : null,
      pix: d.pix ? String(d.pix).trim() : null,
      endereco: d.endereco ? String(d.endereco).trim() : null, email: d.email ? String(d.email).trim() : null,
      observacoes: d.observacoes ? String(d.observacoes) : null, ativo: d.ativo !== false,
    };
    const q = d.id ? db.from("medicos").update(linha).eq("id", String(d.id)) : db.from("medicos").insert(linha);
    const { data, error } = await q.select().single();
    if (error) falha(error.message);
    return data;
  },
  async medico_excluir(d, u) {
    if (u.papel !== "admin") falha("Só o administrador exclui médicos");
    const { error } = await db.from("medicos").delete().eq("id", String(d.id));
    if (error) falha(error.message);
    return { ok: true };
  },

  // ---------- foto 3x4 do paciente ----------
  async pessoa_foto_salvar(d, u) {
    if (u.papel === "paciente") falha("Seu perfil não altera a foto");
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const b64 = String(d.arquivo_base64 ?? "");
    if (!b64) falha("Imagem vazia");
    if (b64.length > 700_000) falha("Imagem muito grande — o painel deveria ter reduzido; tente de novo");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const caminho = `fotos/${String(d.pessoa_id)}.jpg`;
    const { error: eUp } = await db.storage.from("documentos").upload(caminho, bytes, { contentType: "image/jpeg", upsert: true });
    if (eUp) falha("Falha ao guardar a foto: " + eUp.message);
    const { error } = await db.from("pessoas").update({ foto_caminho: caminho }).eq("id", String(d.pessoa_id));
    if (error) falha(error.message);
    return { ok: true, caminho };
  },
  async pessoa_foto_url(d) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const { data: p, error: eP } = await db.from("pessoas").select("foto_caminho").eq("id", String(d.pessoa_id)).single();
    if (eP) falha(eP.message);
    if (!p?.foto_caminho) return { url: null };
    const { data, error } = await db.storage.from("documentos").createSignedUrl(p.foto_caminho, 3600);
    if (error) falha(error.message);
    return { url: data.signedUrl };
  },
  async pessoa_foto_excluir(d, u) {
    if (u.papel === "paciente") falha("Seu perfil não altera a foto");
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    await db.storage.from("documentos").remove([`fotos/${String(d.pessoa_id)}.jpg`]);
    const { error } = await db.from("pessoas").update({ foto_caminho: null }).eq("id", String(d.pessoa_id));
    if (error) falha(error.message);
    return { ok: true };
  },

  async comorbidades_salvar(d, u) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    if (u.papel === "paciente") falha("Seu perfil não ajusta comorbidades");
    const lista = d.comorbidades === null ? null : (Array.isArray(d.comorbidades) ? (d.comorbidades as unknown[]).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 40) : null);
    const { error } = await db.from("pessoas").update({ comorbidades: lista }).eq("id", String(d.pessoa_id));
    if (error) falha(error.message);
    return { ok: true };
  },
  // resumo para a visão geral: anamnese mais recente de cada paciente visível
  async visao_geral(_d, u) {
    let q = db.from("anamneses").select("pessoa_id, versao, concluida, alertas, comorbidades, respostas").order("versao", { ascending: false });
    if (u.pessoas !== null) q = q.in("pessoa_id", u.pessoas.length ? u.pessoas : ["00000000-0000-0000-0000-000000000000"]);
    const { data, error } = await q;
    if (error) falha(error.message);
    const porPessoa: Record<string, unknown> = {};
    for (const a of data ?? []) if (!porPessoa[a.pessoa_id]) porPessoa[a.pessoa_id] = { versao: a.versao, concluida: a.concluida, alertas: a.alertas, comorbidades: a.comorbidades, nasc: (a.respostas as Record<string, unknown>)?.q1 ?? null, mora: (a.respostas as Record<string, unknown>)?.q4 ?? null };
    return porPessoa;
  },

  // ---------- acesso do médico e convites ----------
  async medico_acesso_ler(d) {
    if (!d.medico_id) falha("medico_id obrigatório");
    const { data: us, error } = await db.from("usuarios").select("id, nome, papel, ativo, login, email").eq("medico_id", String(d.medico_id)).limit(1);
    if (error) falha(error.message);
    const usuario = us?.[0] ?? null;
    let pessoaIds: string[] = [], convite = null;
    if (usuario) {
      const { data: vinc } = await db.from("usuarios_pessoas").select("pessoa_id").eq("usuario_id", usuario.id);
      pessoaIds = (vinc ?? []).map((v) => v.pessoa_id);
      convite = await garantirConvite(usuario.id);
    }
    return { usuario: usuario ? { ...usuario, pessoa_ids: pessoaIds } : null, convite };
  },
  async medico_acesso_salvar(d) {
    if (!d.medico_id) falha("medico_id obrigatório");
    const { data: med, error: eM } = await db.from("medicos").select("id, nome").eq("id", String(d.medico_id)).single();
    if (eM) falha(eM.message);
    const { data: us } = await db.from("usuarios").select("id").eq("medico_id", med.id).limit(1);
    const existente = us?.[0] ?? null;
    const login = normLogin(d.login);
    if (!existente && !login) falha("Defina o nome de usuário do médico");
    if (login === "admin") falha("O usuário admin é reservado ao administrador");
    if (login && login.length < 3) falha("Usuário com pelo menos 3 caracteres");
    const linha: Record<string, unknown> = { nome: med.nome, papel: "medico", medico_id: med.id, ativo: d.ativo !== false };
    if (login) linha.login = login;
    if (d.email !== undefined) linha.email = normEmail(d.email) || null;
    const senha = String(d.senha_nova ?? "");
    if (senha) {
      if (senha.length < 6) falha("Senha com pelo menos 6 caracteres");
      linha.senha_hash = await sha256(senha);
    } else if (!existente) falha("Defina a senha inicial");
    const q = existente ? db.from("usuarios").update(linha).eq("id", existente.id) : db.from("usuarios").insert(linha);
    const { data, error } = await q.select("id, nome, ativo, login, email").single();
    if (error) falha(String(error.message).includes("duplicate") || String(error.message).includes("idx_usuarios_login") ? `O usuário "${login}" já existe — escolha outro` : error.message);
    const pessoaIds = (Array.isArray(d.pessoa_ids) ? d.pessoa_ids : []).map(String).filter(Boolean);
    const { error: eDel } = await db.from("usuarios_pessoas").delete().eq("usuario_id", data.id);
    if (eDel) falha(eDel.message);
    if (pessoaIds.length) { const { error: eIns } = await db.from("usuarios_pessoas").insert(pessoaIds.map((pid) => ({ usuario_id: data.id, pessoa_id: pid }))); if (eIns) falha(eIns.message); }
    const convite = await garantirConvite(data.id);
    return { usuario: { ...data, pessoa_ids: pessoaIds }, convite };
  },
  async convite_meu(_d, u) {
    if (u.papel === "paciente" || u.papel === "cuidador") falha("Convites são do administrador e dos médicos");
    return await garantirConvite(u.id); // u.id null = admin
  },
  async convite_regenerar(d, u) {
    let alvo: string | null = u.id;
    if (u.papel === "admin" && d.usuario_id !== undefined) alvo = d.usuario_id ? String(d.usuario_id) : null;
    else if (u.papel !== "admin" && u.papel !== "medico") falha("Sem permissão");
    let q = db.from("convites").delete();
    q = alvo === null ? q.is("usuario_id", null) : q.eq("usuario_id", alvo);
    const { error } = await q; if (error) falha(error.message);
    return await garantirConvite(alvo);
  },
  async convite_ativar(d, u) {
    let alvo: string | null = u.id;
    if (u.papel === "admin" && d.usuario_id !== undefined) alvo = d.usuario_id ? String(d.usuario_id) : null;
    else if (u.papel !== "admin" && u.papel !== "medico") falha("Sem permissão");
    let q = db.from("convites").update({ ativo: d.ativo === true });
    q = alvo === null ? q.is("usuario_id", null) : q.eq("usuario_id", alvo);
    const { error } = await q; if (error) falha(error.message);
    return await garantirConvite(alvo);
  },

  // ---------- rede de cuidado ----------
  async rede_listar(d, u) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const pid = String(d.pessoa_id);
    const { data: vinc, error } = await db.from("usuarios_pessoas").select("usuario_id, usuarios(id, nome, papel, relacao, login, ativo, medico_id)").eq("pessoa_id", pid);
    if (error) falha(error.message);
    const membros = (vinc ?? []).map((v) => v.usuarios as unknown as { id: string; nome: string; papel: string; relacao: string | null; login: string | null; ativo: boolean; medico_id: string | null }).filter(Boolean);
    const medIds = membros.filter((m) => m.medico_id).map((m) => m.medico_id as string);
    let espec: Record<string, string> = {};
    if (medIds.length) {
      const { data: meds } = await db.from("medicos").select("id, especialidade").in("id", medIds);
      espec = Object.fromEntries((meds ?? []).map((m) => [m.id, m.especialidade ?? ""]));
    }
    const uids = membros.map((m) => m.id);
    let comAvisos = new Set<string>();
    let adminAvisos = false;
    {
      let q = db.from("push_inscricoes").select("usuario_id");
      q = uids.length ? q.or(`usuario_id.is.null,usuario_id.in.(${uids.join(",")})`) : q.is("usuario_id", null);
      const { data: ins } = await q;
      for (const i of ins ?? []) { if (i.usuario_id === null) adminAvisos = true; else comAvisos.add(i.usuario_id as string); }
    }
    const lista = membros.map((m) => ({ nome: m.nome, papel: m.papel, relacao: m.relacao, login: m.login, ativo: m.ativo, especialidade: m.medico_id ? (espec[m.medico_id] ?? "") : "", avisos: comAvisos.has(m.id) }));
    lista.push({ nome: "Administrador", papel: "admin", relacao: null, login: "admin", ativo: true, especialidade: "", avisos: adminAvisos });
    return { membros: lista, eu_posso_convidar: true };
  },
  async convite_familiar(d, u) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    return await garantirConviteFamiliar(String(d.pessoa_id), u.id);
  },
  async convite_familiar_regenerar(d, u) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const { error } = await db.from("convites").delete().eq("tipo", "familiar").eq("pessoa_id", String(d.pessoa_id));
    if (error) falha(error.message);
    return await garantirConviteFamiliar(String(d.pessoa_id), u.id);
  },
  async convite_familiar_ativar(d, u) {
    if (!d.pessoa_id) falha("pessoa_id obrigatório");
    const { error } = await db.from("convites").update({ ativo: d.ativo === true }).eq("tipo", "familiar").eq("pessoa_id", String(d.pessoa_id));
    if (error) falha(error.message);
    return await garantirConviteFamiliar(String(d.pessoa_id), u.id);
  },

  // ---------- avisos neste aparelho (push) ----------
  async push_inscrever(d, u) {
    const endpoint = String(d.endpoint ?? "").slice(0, 1000);
    const p256dh = String(d.p256dh ?? ""), auth = String(d.auth ?? "");
    if (!endpoint.startsWith("https://") || !p256dh || !auth) falha("Inscrição inválida");
    const { error } = await db.from("push_inscricoes").upsert(
      { endpoint, p256dh, auth, usuario_id: u.id, rotulo: u.nome },
      { onConflict: "endpoint" },
    );
    if (error) falha(error.message);
    return { ok: true };
  },
  async push_desinscrever(d) {
    const endpoint = String(d.endpoint ?? "");
    if (!endpoint) falha("endpoint obrigatório");
    const { error } = await db.from("push_inscricoes").delete().eq("endpoint", endpoint);
    if (error) falha(error.message);
    return { ok: true };
  },
  async push_estado(d, u) {
    const endpoint = String(d.endpoint ?? "");
    if (!endpoint) return { inscrito: false };
    const { data, error } = await db.from("push_inscricoes").select("id, usuario_id, rotulo").eq("endpoint", endpoint).limit(1);
    if (error) falha(error.message);
    const i = data?.[0];
    if (i && (i.usuario_id ?? null) !== (u.id ?? null)) {
      // o aparelho estava inscrito por outro usuário: passa a ser de quem está logado agora
      const { error: eU } = await db.from("push_inscricoes").update({ usuario_id: u.id, rotulo: u.nome }).eq("id", i.id);
      if (eU) falha(eU.message);
    }
    return { inscrito: !!i };
  },

  async whats_testar(d) {
    const tel = digitos(d.telefone);
    if (!tel) falha("Telefone obrigatório");
    const r = await enviarWhats(tel, "Teste do sistema de lembretes: esta mensagem confirma que o envio está funcionando.");
    return { ok: true, retorno: r.slice(0, 200) };
  },
};

function gerarCodigo(): string {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => letras[x % letras.length]).join("");
}
async function garantirConvite(usuarioId: string | null) {
  let q = db.from("convites").select("codigo, ativo").limit(1);
  q = usuarioId === null ? q.is("usuario_id", null) : q.eq("usuario_id", usuarioId);
  const { data, error } = await q;
  if (error) falha(error.message);
  if (data && data.length) return data[0];
  for (let i = 0; i < 5; i++) {
    const codigo = gerarCodigo();
    const { data: novo, error: eIns } = await db.from("convites").insert({ usuario_id: usuarioId, codigo }).select("codigo, ativo").single();
    if (!eIns) return novo;
    if (!String(eIns.message).includes("duplicate")) falha(eIns.message);
  }
  falha("Não consegui gerar um código de convite");
}
async function garantirConviteFamiliar(pessoaId: string, criadorId: string | null) {
  const { data, error } = await db.from("convites").select("codigo, ativo").eq("tipo", "familiar").eq("pessoa_id", pessoaId).limit(1);
  if (error) falha(error.message);
  if (data && data.length) return data[0];
  for (let i = 0; i < 5; i++) {
    const codigo = gerarCodigo();
    const { data: novo, error: eIns } = await db.from("convites").insert({ tipo: "familiar", pessoa_id: pessoaId, usuario_id: criadorId, codigo }).select("codigo, ativo").single();
    if (!eIns) return novo;
    if (!String(eIns.message).includes("duplicate")) falha(eIns.message);
  }
  falha("Não consegui gerar o código do convite");
}
async function acharConvite(codigo: string) {
  const { data, error } = await db.from("convites").select("usuario_id, ativo, tipo, pessoa_id").eq("codigo", String(codigo).trim().toUpperCase()).limit(1);
  if (error) falha(error.message);
  if (!data || !data.length || !data[0].ativo) falha("Convite inválido ou desativado — peça um link novo a quem convidou você");
  return data[0];
}
// ações públicas: não exigem senha (cadastro pelo convite)
const acoesPublicas: Record<string, (d: Record<string, unknown>) => Promise<unknown>> = {
  // deno-lint-ignore require-await
  async versao() { return { api: VERSAO_API }; },
  // --- recuperação de senha por e-mail ---
  async senha_esqueci(d) {
    const MENSAGEM = "Se este usuário tiver e-mail cadastrado, o código foi enviado. Vale 15 minutos — confira também o spam.";
    const login = normLogin(d.usuario);
    if (!login || login === "admin") return { mensagem: MENSAGEM }; // admin troca a senha pelos Secrets
    const { data: us, error } = await db.from("usuarios").select("id, nome, email").eq("login", login).eq("ativo", true).limit(1);
    if (error) falha(error.message);
    const u = us?.[0];
    if (!u || !u.email) return { mensagem: MENSAGEM }; // não revela quais usuários existem
    const { count } = await db.from("senha_resets").select("id", { count: "exact", head: true }).eq("usuario_id", u.id).gte("criado_em", new Date(Date.now() - 3600000).toISOString());
    if ((count ?? 0) >= 3) falha("Muitos pedidos para este usuário — aguarde 1 hora e tente de novo");
    const codigo = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    const { error: eIns } = await db.from("senha_resets").insert({ usuario_id: u.id, codigo_hash: await sha256(codigo), expira_em: new Date(Date.now() + 15 * 60000).toISOString() });
    if (eIns) falha(eIns.message);
    await enviarEmail(u.email, "Seu código para redefinir a senha — VigilCare",
      `<div style="font-family:sans-serif;max-width:440px"><h2 style="color:#0f5e52">VigilCare</h2><p>Olá, ${escHtml(u.nome)}.</p><p>Use o código abaixo no painel para redefinir sua senha. Ele vale por <b>15 minutos</b>.</p><p style="font-size:30px;letter-spacing:.3em;font-weight:700;margin:16px 0">${codigo}</p><p style="color:#777">Se não foi você quem pediu, ignore este e-mail — sua senha continua a mesma.</p></div>`);
    return { mensagem: MENSAGEM };
  },
  async senha_redefinir(d) {
    const login = normLogin(d.usuario);
    const codigo = String(d.codigo ?? "").replace(/\D/g, "");
    const senha = String(d.senha ?? "");
    if (!login) falha("Informe o usuário");
    if (codigo.length !== 6) falha("Código de 6 dígitos");
    if (senha.length < 6) falha("Senha nova com pelo menos 6 caracteres");
    const { data: us, error } = await db.from("usuarios").select("id").eq("login", login).eq("ativo", true).limit(1);
    if (error) falha(error.message);
    if (!us || !us.length) falha("Código inválido ou vencido — peça um novo");
    const { data: rs, error: eR } = await db.from("senha_resets").select("id, codigo_hash, tentativas").eq("usuario_id", us[0].id).eq("usado", false).gte("expira_em", new Date().toISOString()).order("criado_em", { ascending: false }).limit(1);
    if (eR) falha(eR.message);
    const r0 = rs?.[0];
    if (!r0) falha("Código inválido ou vencido — peça um novo");
    if (r0.tentativas >= 5) falha("Muitas tentativas com este código — peça um novo");
    if (r0.codigo_hash !== await sha256(codigo)) {
      await db.from("senha_resets").update({ tentativas: r0.tentativas + 1 }).eq("id", r0.id);
      falha("Código incorreto");
    }
    const { error: eU } = await db.from("usuarios").update({ senha_hash: await sha256(senha) }).eq("id", us[0].id);
    if (eU) falha(eU.message);
    await db.from("senha_resets").update({ usado: true }).eq("id", r0.id);
    return { ok: true, mensagem: "Senha redefinida — entre com o usuário e a senha nova" };
  },
  async tomada_por_token(d) {
    const tok = String(d.tok ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(tok)) falha("Código inválido");
    const { data: tks, error } = await db.from("envio_tokens").select("id, envio_id, nome").eq("id", tok).limit(1);
    if (error) falha(error.message);
    const t = tks?.[0];
    if (!t) falha("Código inválido ou vencido");
    const { data: env, error: eE } = await db.from("envios").select("id, tipo, status, pessoas(nome), agendamentos(horario, medicacoes(nome, dose))").eq("id", t.envio_id).single();
    if (eE) falha(eE.message);
    const p = env.pessoas as unknown as { nome: string };
    const ag = env.agendamentos as unknown as { horario: string; medicacoes: { nome: string; dose: string | null } | null };
    const oque = env.tipo === "medicacao" ? `${ag?.medicacoes?.nome ?? "remédio"}${ag?.medicacoes?.dose ? " " + ag.medicacoes.dose : ""} das ${String(ag?.horario ?? "").slice(0, 5)}` : "lembrete";
    if (String(d.r) !== "tomei") return { ok: true, mensagem: "" };
    if (env.status === "confirmado") return { ok: true, ja: true, mensagem: `${p.nome}: ${oque} já estava marcado como tomado.` };
    const { error: eU } = await db.from("envios").update({
      status: "confirmado", respondido_em: new Date().toISOString(),
      confirmado_por: t.nome, origem_confirmacao: "push",
    }).eq("id", env.id);
    if (eU) falha(eU.message);
    return { ok: true, mensagem: `${p.nome}: ${oque} marcado como tomado ✓ (por ${t.nome})` };
  },
  async convite_info(d) {
    const c = await acharConvite(String(d.codigo ?? ""));
    if (c.tipo === "familiar" && c.pessoa_id) {
      const { data: pe, error: ePe } = await db.from("pessoas").select("nome").eq("id", c.pessoa_id).single();
      if (ePe) falha(ePe.message);
      return { tipo: "familiar", paciente: pe.nome, convidante: "", detalhe: "" };
    }
    if (c.usuario_id === null) return { convidante: "a equipe do VigilCare", detalhe: "" };
    const { data: us, error } = await db.from("usuarios").select("nome, papel, medico_id").eq("id", c.usuario_id).single();
    if (error) falha(error.message);
    let detalhe = "";
    if (us.medico_id) { const { data: m } = await db.from("medicos").select("especialidade").eq("id", us.medico_id).single(); detalhe = m?.especialidade ?? ""; }
    return { convidante: us.nome, detalhe };
  },
  async convite_cadastrar(d) {
    const c = await acharConvite(String(d.codigo ?? ""));
    const nome = String(d.nome ?? "").trim();
    if (nome.length < 3) falha("Informe o nome completo");
    if (c.tipo === "familiar" && c.pessoa_id) {
      // entra na rede de cuidado do paciente, como cuidador — sem criar paciente novo
      const login = normLogin(d.usuario);
      if (login.length < 3) falha("Escolha um nome de usuário com pelo menos 3 caracteres (letras, números, ponto)");
      if (login === "admin") falha("Esse usuário não está disponível");
      const { data: jaLogin } = await db.from("usuarios").select("id").eq("login", login).limit(1);
      if (jaLogin && jaLogin.length) falha(`O usuário "${login}" já existe — escolha outro`);
      const senha = String(d.senha ?? "");
      if (senha.length < 6) falha("Senha com pelo menos 6 caracteres");
      const emailConv = normEmail(d.email);
      const relacao = d.relacao ? String(d.relacao).trim().slice(0, 40) : "Familiar";
      const { data: usr, error: eU } = await db.from("usuarios").insert({ nome, papel: "cuidador", relacao, senha_hash: await sha256(senha), login, email: emailConv || null, ativo: true }).select("id").single();
      if (eU) falha(eU.message);
      const { error: eV } = await db.from("usuarios_pessoas").insert({ usuario_id: usr.id, pessoa_id: c.pessoa_id });
      if (eV) falha(eV.message);
      return { ok: true, usuario: login, mensagem: "Conta criada — você já faz parte da rede de cuidado" };
    }
    const telefone = digitos(d.telefone);
    if (telefone.length < 12) falha("Informe o WhatsApp com DDD");
    const login = normLogin(d.usuario);
    if (login.length < 3) falha("Escolha um nome de usuário com pelo menos 3 caracteres (letras, números, ponto)");
    if (login === "admin") falha("Esse usuário não está disponível");
    const { data: jaLogin } = await db.from("usuarios").select("id").eq("login", login).limit(1);
    if (jaLogin && jaLogin.length) falha(`O usuário "${login}" já existe — escolha outro`);
    const senha = String(d.senha ?? "");
    if (senha.length < 6) falha("Senha com pelo menos 6 caracteres");
    const emailConv = normEmail(d.email);
    const hash = await sha256(senha);
    const { data: jaTel } = await db.from("pessoas").select("id").eq("telefone", telefone).limit(1);
    if (jaTel && jaTel.length) falha("Já existe um paciente com esse WhatsApp — fale com quem enviou o convite");
    let fuso = "America/Fortaleza";
    try { new Intl.DateTimeFormat("en-US", { timeZone: String(d.fuso) }); fuso = String(d.fuso); } catch { /* fuso inválido → padrão */ }
    const { data: pessoa, error: eP } = await db.from("pessoas").insert({ nome, telefone, fuso, ativa: true }).select("id").single();
    if (eP) falha(eP.message);
    const { data: usr, error: eU } = await db.from("usuarios").insert({ nome, papel: "paciente", senha_hash: hash, login, email: emailConv || null, ativo: true }).select("id").single();
    if (eU) falha("Ficha criada, mas o acesso falhou: " + eU.message);
    const vincs = [{ usuario_id: usr.id, pessoa_id: pessoa.id }];
    if (c.usuario_id) vincs.push({ usuario_id: c.usuario_id, pessoa_id: pessoa.id });
    const { error: eV } = await db.from("usuarios_pessoas").insert(vincs);
    if (eV) falha(eV.message);
    return { ok: true, usuario: login, mensagem: "Conta criada — entre com seu usuário e senha" };
  },
};

// devolve o pessoa_id que a ação toca (undefined = ação sem paciente específico)
async function escopoPessoa(acao: string, d: Record<string, unknown>): Promise<string | null | undefined> {
  const porPessoaId = new Set(["medicacao_salvar", "pressao_horarios_salvar", "agua_horarios_salvar", "sinal_horarios_salvar", "leituras_listar", "leitura_inserir", "envios_listar", "consultas_listar", "consulta_salvar", "documento_upload_url", "documento_salvar", "documentos_listar", "medida_inserir", "medidas_listar", "agua_listar", "agua_inserir", "eventuais_listar", "eventual_salvar", "sinais_listar", "sinal_inserir", "historico_salvar", "anamnese_ler", "anamnese_salvar", "mensagens_listar", "receita_ler", "comorbidades_salvar", "pessoa_foto_salvar", "pessoa_foto_url", "pessoa_foto_excluir", "rede_listar", "convite_familiar", "convite_familiar_regenerar", "convite_familiar_ativar"]);
  if (porPessoaId.has(acao)) return d.pessoa_id ? String(d.pessoa_id) : null;
  if (acao === "pessoa_salvar") return d.id ? String(d.id) : null;
  const tabelaPorAcao: Record<string, [string, string]> = {
    medicacao_excluir: ["medicacoes", "id"], consulta_excluir: ["consultas", "id"], documento_baixar: ["documentos", "id"], documento_excluir: ["documentos", "id"],
    leitura_excluir: ["leituras_pa", "id"], medida_excluir: ["medidas", "id"], agua_excluir: ["agua_registros", "id"], sinal_excluir: ["sinais", "id"],
    eventual_excluir: ["medicamentos_eventuais", "id"], uso_eventual_registrar: ["medicamentos_eventuais", "medicamento_id"], uso_eventual_excluir: ["usos_eventuais", "id"],
    tomada_marcar: ["agendamentos", "agendamento_id"], tomada_desfazer: ["envios", "id"], anamnese_versao_ler: ["anamneses", "id"], anamnese_resumo_ia_salvar: ["anamneses", "id"],
  };
  const t = tabelaPorAcao[acao];
  if (!t) return undefined;
  const id = d[t[1]]; if (!id) return null;
  const { data, error } = await db.from(t[0]).select("pessoa_id").eq("id", String(id)).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.pessoa_id ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return resp({ erro: "use POST" }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return resp({ erro: "JSON inválido" }, 400); }

  // ações públicas (não exigem login): versão, convite e recuperação de senha
  const acao = String(body.acao ?? "");
  if (acoesPublicas[acao]) {
    try { return resp({ ok: true, dados: (await acoesPublicas[acao](body)) ?? {} }); }
    catch (e) { return resp({ ok: false, erro: e instanceof Error ? e.message : String(e) }, 400); }
  }

  if (!PAINEL_SENHA) return resp({ erro: "PAINEL_SENHA não configurada no servidor" }, 500);
  const senha = String(body.senha ?? "");
  const loginTxt = normLogin(body.usuario);
  let usuario: Usuario | null = null;
  if (loginTxt === "admin" || (!loginTxt && senha === PAINEL_SENHA)) {
    if (senha === PAINEL_SENHA) usuario = { id: null, nome: "Administrador", papel: "admin", pessoas: null };
  } else if (loginTxt && senha) {
    const { data: us } = await db.from("usuarios").select("id, nome, papel, medico_id").eq("login", loginTxt).eq("senha_hash", await sha256(senha)).eq("ativo", true).limit(1);
    if (us && us.length) {
      const papel = us[0].papel as Usuario["papel"];
      let pessoas: string[] | null = null;
      if (papel !== "admin") {
        const { data: vinc } = await db.from("usuarios_pessoas").select("pessoa_id").eq("usuario_id", us[0].id);
        pessoas = (vinc ?? []).map((v) => v.pessoa_id);
      }
      usuario = { id: us[0].id, nome: us[0].nome, papel, pessoas, medico_id: us[0].medico_id ?? null };
    }
  }
  if (!usuario) return resp({ erro: "Usuário ou senha incorretos" }, 401);

  const fn = acoes[acao];
  if (!fn) return resp({ erro: `Ação desconhecida: ${acao}` }, 400);

  // ---- permissões por perfil (o filtro é aqui, no servidor) ----
  if (usuario.papel !== "admin") {
    const soAdmin = new Set(["pessoa_excluir", "config_salvar", "usuarios_listar", "usuario_salvar", "usuario_excluir", "whats_testar", "medico_excluir", "medico_acesso_ler", "medico_acesso_salvar"]);
    const negadasPaciente = new Set(["pessoa_salvar", "medicacao_salvar", "medicacao_excluir", "pressao_horarios_salvar", "agua_horarios_salvar", "sinal_horarios_salvar", "eventual_salvar", "eventual_excluir", "grupos_listar", "receita_ler", "medico_salvar"]);
    if (soAdmin.has(acao) || (usuario.papel === "paciente" && negadasPaciente.has(acao))) return resp({ erro: "Seu perfil não tem permissão para esta ação" }, 403);
    try {
      const pid = await escopoPessoa(acao, body);
      if (pid !== undefined && !pode(usuario, pid)) return resp({ erro: "Sem acesso a este paciente" }, 403);
    } catch (e) { return resp({ erro: "Verificação de acesso falhou: " + String(e) }, 400); }
  }

  try {
    const dados = await fn(body, usuario);
    return resp({ ok: true, dados });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`ERRO painel-api [${acao}]:`, msg);
    return resp({ ok: false, erro: msg }, 400);
  }
});
