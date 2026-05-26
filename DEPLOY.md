# Deploiement mcp-gads, contexte Rablab

Pas a pas pour passer du repo vide au worker live.

## Repartition des comptes Google

Trois identites Google differentes interviennent. Ne pas les confondre.

| Role | Compte | Pourquoi |
| --- | --- | --- |
| Proprietaire du projet GCP "Rablab MCP" | `ppc.rablab@gmail.com` | Hebergeur historique des OAuth Clients Rablab (GA4/GSC, DataForSEO, et maintenant mcp-gads). |
| Proprietaire du worker Cloudflare et du repo GitHub | `ppc.rablab@gmail.com` | Account Rablab `8f873876f6a5c1875b3b12dced29b1af` et organisation `rablab-mtl`. |
| Utilisateur Google qui se connecte au worker via OAuth | `plateformes@rablab.ca` | Compte qui detient l'acces au MCC Google Ads et qui peut demander le Developer Token. |

## Prerequis

- Acces a la console GCP du projet Rablab MCP (ppc.rablab@gmail.com).
- Acces au compte plateformes@rablab.ca et au MCC Google Ads qu'il gere.
- Acces au dashboard Cloudflare Rablab (account `8f873876f6a5c1875b3b12dced29b1af`).
- Repo GitHub vide `rablab-mtl/mcp-gads` cree.

## 1. Cote Google Cloud (projet Rablab MCP)

### 1.1 Activer l'API Google Ads

https://console.cloud.google.com/apis/library/googleads.googleapis.com?authuser=1&project=rablab-mcp

Cliquer **Enable**. (Si deja active, OK.)

### 1.2 Creer le OAuth Client Web Application

https://console.cloud.google.com/auth/clients/create?authuser=1&project=rablab-mcp

Formulaire:

- Type d'application: `Application Web`
- Nom: `Rablab Google Ads MCP`
- URI de redirection autorise: `https://mcp-gads.rablab.workers.dev/callback`
- (Optionnel pour dev local) ajouter: `http://localhost:8789/callback`
- Cliquer `Creer`

Une popup affiche le `Client ID` et le `Client Secret`. **Copier les deux** dans 1Password Rablab.

### 1.3 Ajouter les utilisateurs testers a l'OAuth Consent Screen

https://console.cloud.google.com/auth/audience?authuser=1&project=rablab-mcp

Cliquer `Add users`, ajouter en priorite le compte qui detient l'acces au MCC Google Ads, puis les autres emails Rablab qui doivent utiliser le worker (max 100 testers en mode Testing):

- `plateformes@rablab.ca` (compte qui se connecte au worker, doit etre present sinon le OAuth flow echoue)
- `julien.c@rablab.ca`
- `ppc.rablab@gmail.com`

## 2. Developer Token Google Ads

Le developer token est rattache au MCC, pas au projet GCP. Une seule etape, mais c'est le plus long delai du projet.

1. Se connecter au MCC Rablab avec `plateformes@rablab.ca`.
2. Aller dans `Tools and settings -> API Center` (visible uniquement sur un manager account).
3. Demander un nouveau token. Il demarre en Test Access (test accounts only).
4. Apply for Basic Access pour acceder aux comptes de production. Approbation: 1 a 5 jours ouvres.
5. Copier la valeur du token et la mettre dans 1Password Rablab.

## 3. Cote Cloudflare

### 3.1 Creer un KV namespace dedie

```bash
npx wrangler kv namespace create OAUTH_KV
```

Copier l'ID retourne. Mettre cette valeur dans `wrangler.jsonc`, champ `kv_namespaces[0].id`, a la place de `REPLACE_WITH_OAUTH_KV_ID`.

### 3.2 (Optionnel) Mettre le MCC dans wrangler.jsonc

Si tu veux un MCC par defaut pour ne pas avoir a le passer a chaque appel, editer `wrangler.jsonc` et mettre `vars.GADS_LOGIN_CUSTOMER_ID` a la valeur du MCC, 10 chiffres sans tirets.

## 4. Setter les secrets et deployer

Depuis un terminal local, dans le dossier du worker:

```bash
cd ~/Documents/Claude/Projects/Interne/MCP/mcp-gads

# Login Cloudflare si necessaire
npx wrangler login

# Setter les secrets, prompt par prompt
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY
# (coller le resultat de: openssl rand -hex 32)

npx wrangler secret put HOSTED_DOMAIN
# (Entree vide, on accepte plusieurs comptes Google)

npx wrangler secret put ALLOWED_EMAILS
# (plateformes@rablab.ca,julien.c@rablab.ca,ppc.rablab@gmail.com, et tout autre email Rablab autorise)

npx wrangler secret put ALLOWED_DOMAINS
# (rablab.ca pour autoriser tous les emails du domaine, ou Entree vide si on prefere la whitelist email pure)

npx wrangler secret put GADS_DEVELOPER_TOKEN
# (coller le developer token genere en etape 2)

# Deployer
npx wrangler deploy
```

Le worker est live a `https://mcp-gads.rablab.workers.dev`.

## 5. Tester avec MCP Inspector

```bash
npx @modelcontextprotocol/inspector@latest
```

Ouvrir `http://localhost:6274`. Transport Type: SSE. URL: `https://mcp-gads.rablab.workers.dev/sse`. Connect. OAuth Google s'ouvre, approuver le scope `adwords`. Tester:

1. `gads_list_accessible_customers` (no args), doit lister les customer_ids accessibles a l'utilisateur connecte.
2. `gads_get_customer` avec un customer_id, doit retourner descriptive_name, devise, timezone.
3. `gads_get_account_summary` avec un customer_id et `date_range: LAST_30_DAYS`, doit retourner les KPIs globaux.

Si tu te connectes avec un email NON whiteliste, tu dois voir la page rouge "Acces refuse" en orange Rablab. Verifier ce comportement avant de partager l'URL.

## 6. Connecter dans Claude Desktop / Cowork

Dans `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gads": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp-gads.rablab.workers.dev/sse"]
    }
  }
}
```

Restart Claude Desktop. Le worker apparait dans la liste des MCPs. Premier appel = OAuth flow.

## 7. CI/CD via Cloudflare Workers Builds

Dans le dashboard Cloudflare Workers, brancher le repo `rablab-mtl/mcp-gads`:

- Build command: `npm install --legacy-peer-deps`
- Deploy command: `npx wrangler deploy`
- Production branch: `main`

Chaque push sur `main` redeploie automatiquement.

## 8. Diffusion a Rablab

Partager l'URL `https://mcp-gads.rablab.workers.dev/sse` avec l'equipe. Chaque membre fait son OAuth flow avec son propre compte Google, et n'a acces qu'aux comptes Google Ads ou il a deja les droits.

Limite testers: 100 max en mode Testing. Au-dela, faire la verification Google (2 a 4 semaines).

## En cas de souci

Logs du worker en temps reel:

```bash
npx wrangler tail mcp-gads
```

Tester un GAQL directement en HTTP:

```bash
curl -X POST "https://googleads.googleapis.com/v20/customers/CUSTOMER_ID/googleAds:search" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "developer-token: YOUR_DEV_TOKEN" \
  -H "login-customer-id: YOUR_MCC_ID" \
  -H "Content-Type: application/json" \
  -d '{"query":"SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1"}'
```

Si la reponse est `USER_PERMISSION_DENIED`, verifier que le compte connecte a bien acces a ce customer_id, et que le `login-customer-id` (header ou parametre) pointe vers le bon MCC.
