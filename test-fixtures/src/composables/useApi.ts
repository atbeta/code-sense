import { ref, type Ref } from 'vue';
import axios, { type AxiosResponse } from 'axios';

/**
 * @composable-type: data-fetching
 * @cache-strategy: stale-while-revalidate
 */
export function useApi<T>(url: string) {
  const data: Ref<T | null> = ref(null);
  const error: Ref<Error | null> = ref(null);
  const loading = ref(false);

  async function fetch() {
    loading.value = true;
    error.value = null;
    try {
      const response: AxiosResponse<T> = await axios.get(url);
      data.value = response.data;
    } catch (e) {
      error.value = e as Error;
    } finally {
      loading.value = false;
    }
  }

  return { data, error, loading, fetch };
}
