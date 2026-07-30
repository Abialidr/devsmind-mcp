// RTK Query createApi with property-assignment endpoints — exercises detectRtkEndpointAliases
// / detectRtkEndpointNodes. Expected generated hook aliases:
//   getUser (query)    -> useGetUserQuery, useLazyGetUserQuery
//   updateUser (mutation) -> useUpdateUserMutation
import { createApi } from '@reduxjs/toolkit/query/react';

export const api = createApi({
  reducerPath: 'api',
  endpoints: (builder) => ({
    getUser: builder.query<{ id: string }, string>({
      query: (id) => `/users/${id}`
    }),
    updateUser: builder.mutation<void, { id: string }>({
      query: (body) => ({ url: `/users/${body.id}`, method: 'PUT', body })
    })
  })
});
