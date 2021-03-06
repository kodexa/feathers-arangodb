import { NotFound } from "@feathersjs/errors";
import { Database, DocumentCollection } from "arangojs";
import { LoadBalancingStrategy } from "arangojs/lib/async/connection";
import { AqlQuery } from "arangojs/lib/cjs/aql-query";
import { ArangoError } from "arangojs/lib/cjs/error";
import { Graph } from "arangojs/lib/cjs/graph";
import {
  Application,
  Id,
  NullableId,
  Paginated,
  Params,
  Service
} from "feathersjs__feathers";
import _isEmpty from "lodash.isempty";
import isString from "lodash.isstring";
import omit from "lodash.omit";
import uuid from "uuid/v4";
import { AutoDatabse } from "./auto-database";
import { QueryBuilder } from "./queryBuilder";
import { GraphVertexCollection } from "arangojs/lib/cjs/graph";
import { ArrayCursor } from "arangojs/lib/cjs/cursor";

export declare type ArangoDbConfig =
  | string
  | string[]
  | Partial<{
      url: string | string[];
      isAbsolute: boolean;
      arangoVersion: number;
      loadBalancingStrategy: LoadBalancingStrategy;
      maxRetries: false | number;
      agent: any;
      agentOptions: {
        [key: string]: any;
      };
      headers: {
        [key: string]: string;
      };
    }>;

export enum AUTH_TYPES {
  BASIC_AUTH = "BASIC_AUTH",
  BEARER_AUTH = "BEARER_AUTH"
}

export declare interface Paginate {
  max?: number;
  default?: number;
}

export interface IConnectResponse {
  database: AutoDatabse | Database;
  collection: DocumentCollection | GraphVertexCollection;
  graph?: Graph;
}

export interface IGraphOptions {
  properties?: any;
  opts?: { waitForSync?: boolean };
}

export interface IOptions {
  id?: string;
  expandData?: boolean;
  collection:
    | DocumentCollection
    | GraphVertexCollection
    | string
    | Promise<DocumentCollection | GraphVertexCollection>;
  database: AutoDatabse | Database | string | Promise<AutoDatabse | Database>;
  graph?: Graph | IGraphOptions;
  authType?: AUTH_TYPES;
  username?: string;
  password?: string;
  token?: string;
  dbConfig?: ArangoDbConfig;
  events?: any[];
  paginate?: Paginate;
}

export interface IArangoDbService<T> extends Service<T> {
  events: any[];
  paginate: Paginate;
  readonly id: string;
  readonly database: Database;
  readonly collection: DocumentCollection | GraphVertexCollection;
  connect(): Promise<IConnectResponse>;
  setup(): Promise<void>;
}

export class DbService {
  public events: any[] = [];
  public readonly options: IOptions;
  private readonly _id: string;
  private _database: AutoDatabse | Database | undefined;
  private _databasePromise: Promise<AutoDatabse | Database> | undefined;
  private _collection: DocumentCollection | GraphVertexCollection | undefined;
  private _collectionPromise:
    | Promise<DocumentCollection | GraphVertexCollection>
    | undefined;
  private _graph: Graph | undefined;
  private _graphPromise: Promise<Graph> | undefined;
  private _paginate: Paginate;
  constructor(options: IOptions) {
    // Runtime checks
    /* istanbul ignore next */
    if (!options.collection) {
      throw new Error("A collection reference or name is required");
    }
    /* istanbul ignore next */
    if (!options.database) {
      throw new Error("A database reference or name is required");
    }
    /* istanbul ignore next */
    if (options.id && ["_rev"].indexOf(options.id) !== -1) {
      throw new Error(`Database id name of ${options.id} is a reserved key`);
    }
    this._id = options.id || "_id";
    this.events = options.events || this.events;
    this._paginate = options.paginate || {};
    this.options = options;
    // Set the database if passed an existing DB
    /* istanbul ignore next */
    if (options.database instanceof Promise) {
      this._databasePromise = options.database;
    } else if (options.database instanceof AutoDatabse) {
      this._database = options.database;
    } else if (!isString(options.database)) {
      throw new Error("Database reference or name (string) is required");
    }

    if (options.graph instanceof Promise) {
      this._graphPromise = options.graph;
    }
    else if (options.graph instanceof Graph) {
      this._graph = options.graph;
    }

    // Set the collection if it is connected
    /* istanbul ignore next */
    if (options.collection instanceof Promise) {
      this._collectionPromise = options.collection;
    } else if (!isString(options.collection) && !!options.collection) {
      this._collection = <DocumentCollection | GraphVertexCollection>(
        options.collection
      );
    } else if (!options.collection) {
      throw new Error("Collection reference or name (string) is required");
    }
  }

  public async connect(): Promise<IConnectResponse> {
    const { authType, username, password, token, graph, dbConfig } = this.options;
    if (this._database === undefined && this._databasePromise) {
      this._database = await this._databasePromise;
    }
    /* istanbul ignore next */
    if (this._database === undefined) {
      let db = new AutoDatabse(dbConfig);
      switch (authType) {
        case AUTH_TYPES.BASIC_AUTH:
          db.useBasicAuth(username, password);
          break;
        case AUTH_TYPES.BEARER_AUTH:
          /* istanbul ignore next  Testing will assuming working SDK  */
          if (token) {
            await db.useBearerAuth(token || "");
          } else {
            await db.login(username, password);
          }
          break;
      }
      await db.autoUseDatabase(this.options.database as string);
      this._database = db;
    }

    if (!this._graph && this._graphPromise) {
      this._graph = await this._graphPromise;
    }

    if (graph && !this._graph) {
      const { properties, opts } = <IGraphOptions>graph;
      if (this._database instanceof AutoDatabse) {
        this._graph = await this._database.autoGraph(properties, opts);
      } else {
        throw `Auto creation of graphs requires instance of AutoDatabase`;
      }
    }

    /* istanbul ignore next  This doens't need to be tested  */
    if (this._collectionPromise) {
      this._collection = await this._collectionPromise;
    }

    if (this._collection === undefined) {
      if (this._database instanceof AutoDatabse) {
        this._collection = await this._database.autoCollection(this.options
          .collection as string);
      } else {
        throw `Auto creation of collections requires instance of AutoDatabase`;
      }
    }

    return {
      database: this._database,
      collection: this._collection
    };
  }

  get id(): string {
    return this._id;
  }

  get database(): AutoDatabse | Database | undefined {
    return this._database;
  }

  get collection(): DocumentCollection | GraphVertexCollection | undefined {
    return this._collection;
  }

  get paginate(): Paginate {
    return this._paginate;
  }

  set paginate(option: Paginate) {
    this._paginate = option || this._paginate;
  }

  public _injectPagination(params: Params): Params {
    params = params || {};
    if (_isEmpty(this._paginate) || (params && params.paginate) === false) {
      return params;
    }
    const paginate = (params.paginate as Paginate) || this._paginate;
    params.query = params.query || {};
    let limit = parseInt(params.query.$limit);
    limit =
      isNaN(limit) || limit === null
        ? paginate.default || paginate.max || 0
        : limit;
    limit = Math.min(limit, paginate.max || paginate.default || limit);
    params.query.$limit = limit;
    return params;
  }

  public fixKeySend<T>(data: T | T[]): Partial<T> | Array<Partial<T>> {
    const aData: any[] = Array.isArray(data) ? data : [data];
    if (aData.length < 1) {
      return aData;
    }
    return aData.map((item: any) => {
      const id = item[this._id] || uuid();
      return { _key: id, ...omit(item, "_id", "_rev", "_key") };
    }) as Array<Partial<T>>;
  }

  public fixKeyReturn(item: any): any {
    const idObj: any = {};
    idObj[this._id] = item._key;
    const removeKeys = [this._id, "_key"];
    if (!this.options.expandData) {
      removeKeys.push("_id", "_rev");
    }
    return { ...idObj, ...omit(item, removeKeys) };
  }

  public async _returnMap(
    database: AutoDatabse | Database,
    query: AqlQuery,
    errorMessage?: string,
    removeArray = true,
    paging = false
  ) {
    const cursor: ArrayCursor = <ArrayCursor>(
      await database
        .query(query, { count: paging, options: { fullCount: paging } })
        .catch(error => {
          if (
            error &&
            error.isArangoError &&
            error.errorNum === 1202 &&
            errorMessage
          ) {
            throw new NotFound(errorMessage);
          } else {
            throw error;
          }
        })
    );
    const result: any[] = await cursor.map(item => this.fixKeyReturn(item));
    if (result.length === 0 && errorMessage) {
      throw new NotFound(errorMessage);
    }
    if (paging) {
      return {
        total: cursor.extra.stats.fullCount,
        data: result
      };
    }
    return result.length > 1 || !removeArray ? result : result[0];
  }

  public async find(params: Params): Promise<any[] | Paginated<any>> {
    const { database, collection } = await this.connect();
    params = this._injectPagination(params);
    const queryBuilder = new QueryBuilder(params);
    const colVar = queryBuilder.addBindVar(collection.name, true);
    const query: AqlQuery = {
      query: `
        FOR doc IN ${colVar}
          ${queryBuilder.filter}
          ${queryBuilder.sort}
          ${queryBuilder.limit}
          ${queryBuilder.returnFilter}
      `,
      bindVars: queryBuilder.bindVars
    };
    const result = (await this._returnMap(
      database,
      query,
      undefined,
      false,
      !_isEmpty(this._paginate)
    )) as any;
    if (!_isEmpty(this._paginate)) {
      return {
        total: result.total,
        // @ts-ignore   Will be defined based on previous logic
        limit: params.query.$limit || 0,
        // @ts-ignore   Will be defined based on previous logic
        skip: params.query.$skip || 0,
        data: result.data
      };
    }
    return result;
  }

  public async get(id: Id, params: Params) {
    const { database, collection } = await this.connect();
    const queryBuilder = new QueryBuilder(params);
    const query: AqlQuery = {
      query: `
        FOR doc IN ${queryBuilder.addBindVar(collection.name, true)}
          FILTER doc._key == ${queryBuilder.addBindVar(id)}
          ${queryBuilder.filter}
          ${queryBuilder.returnFilter}
      `,
      bindVars: queryBuilder.bindVars
    };
    return this._returnMap(database, query, `No record found for id '${id}'`);
  }

  public async create(
    data: Partial<any> | Array<Partial<any>>,
    params: Params
  ) {
    data = this.fixKeySend(data);
    const { database, collection } = await this.connect();
    const queryBuilder = new QueryBuilder(params);
    const query: AqlQuery = {
      query: `
        FOR item IN ${queryBuilder.addBindVar(data)}
          INSERT item IN ${queryBuilder.addBindVar(collection.name, true)}
          let doc = NEW
          ${queryBuilder.returnFilter}
      `,
      bindVars: queryBuilder.bindVars
    };
    return this._returnMap(database, query);
  }

  public async _replaceOrPatch(
    fOpt = "REPLACE",
    id: NullableId | NullableId[],
    data: Partial<any>,
    params: Params
  ) {
    const { database, collection } = await this.connect();
    const ids: NullableId[] = Array.isArray(id) ? id : [id];
    let query: AqlQuery;
    if (ids.length > 0 && (ids[0] != null || ids[0] != undefined)) {
      const queryBuilder = new QueryBuilder(params, "doc", "changed");
      const colRef = queryBuilder.addBindVar(collection.name, true);
      query = {
        query: `
        FOR doc IN ${queryBuilder.addBindVar(ids)}
          ${fOpt} doc WITH ${queryBuilder.addBindVar(data)} IN ${colRef}
          LET changed = NEW
          ${queryBuilder.returnFilter}
      `,
        bindVars: queryBuilder.bindVars
      };
    } else {
      const queryBuilder = new QueryBuilder(params, "doc", "changed");
      const colRef = queryBuilder.addBindVar(collection.name, true);
      query = {
        query: `
        FOR doc IN ${colRef}
          ${queryBuilder.filter}
          ${fOpt} doc WITH ${queryBuilder.addBindVar(data)} IN ${colRef}
          LET changed = NEW
          ${queryBuilder.returnFilter}
      `,
        bindVars: queryBuilder.bindVars
      };
    }
    return this._returnMap(database, query, `No record found for id '${id}'`);
  }

  public async update(
    id: NullableId | NullableId[],
    data: Partial<any>,
    params: Params
  ) {
    return this._replaceOrPatch("REPLACE", id, data, params);
  }

  public async patch(
    id: NullableId | NullableId[],
    data: Partial<any>,
    params: Params
  ) {
    return this._replaceOrPatch("UPDATE", id, data, params);
  }

  public async remove(id: NullableId | NullableId[], params: Params) {
    // Eliminate null or empty clauses
    const ids: NullableId[] = Array.isArray(id) ? id : [id];
    // Setup connection & verify
    const { database, collection } = await this.connect();
    if (!database) {
      throw new Error("Database not initialized");
    }
    if (!collection) {
      throw new Error("Collection not initialized");
    }
    // Build query
    let query: AqlQuery;
    if (id && (!Array.isArray(id) || (Array.isArray(id) && id.length > 0))) {
      const queryBuilder = new QueryBuilder(params, "doc", "removed");
      query = {
        query: `
        FOR doc IN ${queryBuilder.addBindVar(ids)}
          REMOVE doc IN ${queryBuilder.addBindVar(collection.name, true)}
          LET removed = OLD
          ${queryBuilder.returnFilter}
      `,
        bindVars: queryBuilder.bindVars
      };
    } else {
      const queryBuilder = new QueryBuilder(params, "doc", "removed");
      const colRef = queryBuilder.addBindVar(collection.name, true);
      query = {
        query: `
        FOR doc IN ${colRef}
          ${queryBuilder.filter}
          REMOVE doc IN ${colRef}
          LET removed = OLD
          ${queryBuilder.returnFilter}
      `,
        bindVars: queryBuilder.bindVars
      };
    }

    return this._returnMap(database, query);
    // let cursor: ArrayCursor;
    // cursor = await database.query(query);
    // let result: any[] = await cursor.map(item => this.fixKeyReturn(item));
    // return result.length > 1 ? result : result[0];
  }

  public async setup(app: Application, path: string) {
    await this.connect();
  }
}

export default function ArangoDbService(options: IOptions): DbService | any {
  return new DbService(options);
}
