export interface QueryParser {
    parse(query: string): ParametrizedQuery;
}

export interface ParametrizedQuery {
    query: string;
    paramNames: string[];
}

export interface ParameterWithNames {
    paramNames: string[];
    values: any[];
}