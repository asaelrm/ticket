import { useQuery } from '@tanstack/react-query';
import { api } from './api';

// Equipos del usuario autenticado.
//
// Sirve para una sola decisión, tomada aquí para que Bandeja y Todos los
// tickets no puedan discrepar: si la vista "Mi equipo" se ofrece. No es un
// filtro de datos ni un permiso; el backend ya limita cada ticket según el
// usuario, esto sólo evita ofrecer una vista que, sin equipos, siempre saldría
// vacía (en DEV llegó a estar permanentemente en 0).
//
// La lista cambia desde la pantalla de Equipos, así que se cachea como el resto
// de directorios y no se vuelve a pedir al cambiar de pestaña o de filtros.
const MY_TEAMS_KEY = ['my-teams'];

export function useMyTeams() {
  const { data, isPending, isError } = useQuery({
    queryKey: MY_TEAMS_KEY,
    queryFn: () => api.get('/api/teams/mine').then((d) => d.data || []),
  });

  const teams = data ?? [];
  // Confirmado es la clave de todo: mientras vuela la petición o si falla no se
  // sabe nada del usuario, y ante la duda se enseña la vista. Ocultarla por un
  // fallo de red sería el error caro; además, corregir una URL inválida con una
  // suposición también lo sería.
  const confirmed = !isPending && !isError;

  return {
    teams,
    confirmed,
    hasTeams: confirmed && teams.length > 0,
    hasNoTeams: confirmed && teams.length === 0,
  };
}