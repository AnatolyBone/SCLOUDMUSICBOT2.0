import axios from 'axios';

export async function resolveRedirect(url) {
  try {
    const response = await axios.head(url, { maxRedirects: 10 });
    return response.request.res.responseUrl;
  } catch (error) {
    console.error(`Ошибка при разрешении редиректа для ${url}:`, error.message);
    return url;
  }
}
