/**
 * @experimental
 */
export interface QueryParser {
    parse(query: string): ParametrizedQuery;
}

/**
 * @experimental
 */
export interface ParametrizedQuery {
    query: string;
    paramNames: string[];
}

/**
 * @experimental
 */
export interface ParameterWithNames {
    paramNames: string[];
    values: any[];
}