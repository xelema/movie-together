// Lecture des réponses de l'API. Pendant un déploiement le proxy répond une
// page HTML (502, 504) : son corps ne se lit pas en JSON, et l'erreur de
// parsing du navigateur ne doit jamais remplacer la cause. Le statut HTTP
// reste attaché à l'erreur, avec le message source du serveur (non traduit)
// pour qui doit reconnaître un refus précis.
export async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

export function responseError(status, body, { label = text => text, t = fr => fr } = {}) {
  const source = typeof body?.error === 'string' && body.error ? body.error : null;
  const message = source ? label(source)
    : status >= 500 || !status
      ? t('Serveur indisponible, réessayez dans un instant.', '서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.', 'Máy chủ không phản hồi, hãy thử lại sau giây lát.')
      : t('Une erreur est survenue.', '오류가 발생했습니다.', 'Đã xảy ra lỗi.');
  return Object.assign(new Error(source || !status ? message : `${message} (HTTP ${status})`), { status, source });
}

// Le résultat d'une réponse, ou une erreur lisible : une réponse réussie dont
// le corps n'est pas du JSON est aussi un échec, jamais une valeur null muette.
export async function jsonResult(response, translate) {
  const body = await readJson(response);
  if (!response.ok || body === null) throw responseError(response.status, body, translate);
  return body;
}
