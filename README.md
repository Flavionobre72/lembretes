# VigilCare

Acompanhamento de saúde: remédios, medições, consultas e prontuário, com lembretes por WhatsApp e avisos no celular (push).

## Estrutura

- `painel/` — o painel web (site estático). O Netlify publica esta pasta: todo push aqui vira deploy automático em https://stellar-raindrop-1ab6e5.netlify.app
- `supabase/functions/painel-api/` — API do painel (Supabase Edge Function)
- `supabase/functions/lembretes/` — disparador de lembretes (cron a cada minuto: WhatsApp + push)

## Deploy

- **Painel:** automático — push na `main` → Netlify publica `painel/` (sem build, site estático).
- **Funções:** publicadas no Supabase (projeto `lembretes-saude`); este repositório guarda a cópia de referência de cada versão no ar.

Versões atuais: Painel 020 · painel-api v19 · lembretes v5.
