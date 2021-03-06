import { Keystone as BaseKeystone } from '@keystonejs/keystone';
import { MongooseAdapter } from '@keystonejs/adapter-mongoose';
import { KnexAdapter } from '@keystonejs/adapter-knex';
import type {
  SerializedAdminMeta,
  KeystoneConfig,
  Keystone,
  SessionContext,
} from '@keystone-spike/types';
import { sessionStuff } from '../session';
import type { IncomingMessage, ServerResponse } from 'http';
import { mergeSchemas } from '@graphql-tools/merge';
import { gql } from '../schema';
import { GraphQLSchema, GraphQLScalarType } from 'graphql';
import { mapSchema } from '@graphql-tools/utils';

export function createKeystone(config: KeystoneConfig): Keystone {
  let keystone = new BaseKeystone({
    name: config.name,
    adapter:
      config.db.adapter === 'knex'
        ? new KnexAdapter({ knexOptions: { connection: config.db.url } })
        : new MongooseAdapter({ mongoUri: config.db.url }),
    cookieSecret: '123456789',
    queryLimits: config.graphql?.queryLimits,
  });

  const sessionStrategy = config.session?.();

  const adminMeta: SerializedAdminMeta = {
    enableSessionItem: config.admin?.enableSessionItem || false,
    enableSignout: sessionStrategy?.end !== undefined,
    lists: {},
  };
  let uniqueViewCount = -1;
  const stringViewsToIndex: Record<string, number> = {};
  const views: string[] = [];
  function getViewId(view: string) {
    if (stringViewsToIndex[view] !== undefined) {
      return stringViewsToIndex[view];
    }
    uniqueViewCount++;
    stringViewsToIndex[view] = uniqueViewCount;
    views.push(view);
    return uniqueViewCount;
  }
  Object.keys(config.lists).forEach(key => {
    let listConfig = config.lists[key];
    keystone.createList(key, {
      fields: Object.fromEntries(
        Object.entries(listConfig.fields).map(([key, field]) => [
          key,
          { type: (field as any).type, ...(field as any).config },
        ])
      ),
      access: listConfig.access,
      queryLimits: listConfig.graphql?.queryLimits,
      schemaDoc: listConfig.graphql?.description ?? listConfig.description,
      listQueryName: listConfig.graphql?.listQueryName,
      itemQueryName: listConfig.graphql?.itemQueryName,
      hooks: listConfig.hooks,
    } as any);
    adminMeta.lists[key] = {
      key,
      description: listConfig.graphql?.description ?? listConfig.description,
      label: (keystone as any).lists[key].adminUILabels.label,
      fields: {},
      path: (keystone as any).lists[key].adminUILabels.path,
      gqlNames: (keystone as any).lists[key].gqlNames,
    };
    for (const fieldKey of Object.keys(listConfig.fields)) {
      let field = listConfig.fields[fieldKey];
      let view = field.config.admin?.views ?? field.views;
      adminMeta.lists[key].fields[fieldKey] = {
        label: fieldKey,
        views: getViewId(view),
        fieldMeta: field.getAdminMeta?.(),
      };
    }
  });
  // @ts-ignore
  const server = keystone.createApolloServer({
    schemaName: 'public',
    dev: process.env.NODE_ENV === 'development',
  });
  let sessionThing = sessionStrategy ? sessionStuff(sessionStrategy) : undefined;
  const schemaFromApolloServer: GraphQLSchema = server.schema;
  const schema = mapSchema(schemaFromApolloServer, {
    'MapperKind.SCALAR_TYPE'(type) {
      // because of a bug in mergeSchemas which duplicates directives on scalars,
      // we're removing specifiedByUrl from the scalar
      // https://github.com/ardatan/graphql-tools/issues/2031
      if (type instanceof GraphQLScalarType && type.name === 'JSON') {
        return new GraphQLScalarType({
          name: type.name,
          description: type.description,
          parseLiteral: type.parseLiteral,
          parseValue: type.parseValue,
          serialize: type.serialize,
        });
      }
      return type;
    },
  });

  let graphQLSchema =
    config.extendGraphqlSchema?.(
      schema,
      // TODO: find a way to not do this
      keystone
    ) || schema;
  if (sessionStrategy?.end) {
    graphQLSchema = mergeSchemas({
      schemas: [graphQLSchema],
      typeDefs: gql`
        type Mutation {
          endSession: Boolean!
        }
      `,
      resolvers: {
        Mutation: {
          async endSession(rootVal, args, ctx) {
            await ctx.endSession();
            return true;
          },
        },
      },
    });
  }
  graphQLSchema = mergeSchemas({
    schemas: [graphQLSchema],
    typeDefs: gql`
      type Query {
        _adminMeta: JSON!
      }
    `,
    resolvers: {
      Query: {
        async _adminMeta(rootVal, args, ctx) {
          if (sessionThing === undefined) {
            return adminMeta;
          }
          if (
            (await config.admin?.isAccessAllowed?.({ session: ctx.session })) ??
            ctx.session !== undefined
          ) {
            return adminMeta;
          }
          // TODO: ughhhhhh, we really need to talk about errors.
          // mostly unrelated to above: error or return null here(+ make field nullable)?s
          throw new Error('Access denied');
        },
      },
    },
  });
  async function createContext({
    sessionContext,
    skipAccessControl = false,
  }: {
    sessionContext?: SessionContext;
    skipAccessControl?: boolean;
  }) {
    return {
      schemaName: 'public',
      // authedItem: authentication.item,
      // authedListKey: authentication.listKey,
      ...(keystone as any)._getAccessControlContext({
        schemaName: 'public',
        authentication: {
          ...(sessionContext?.session as any),
          // TODO: Keystone makes assumptions about the shape of this object
          item: true,
        },
        skipAccessControl,
      }),
      totalResults: 0,
      keystone,
      maxTotalResults: (keystone as any).queryLimits.maxTotalResults,
      createContext,
      ...sessionContext,
    };
  }
  return {
    keystone,
    adminMeta,
    graphQLSchema,
    views,
    createSessionContext: sessionThing?.createContext,
    async createContext(req: IncomingMessage, res: ServerResponse) {
      let sessionContext = await sessionThing?.createContext(req, res);

      return createContext({ sessionContext });
    },
    config,
  };
}
