import { describe, expect, it } from "vitest";
import { generateColumns, reconcileTableColumnsSql } from "./schema-generator.js";

describe("schema column labels", () => {
  it("uses the DHIS2 data element name instead of a blank form name or UID", () => {
    const columns = generateColumns("dataset", {
      dataSetElements: [{
        dataElement: {
          id: "ViVJxHnj3zp",
          name: "Post-kala-azar dermal leishmaniasis",
          displayName: "PKDL cases",
          formName: "",
          valueType: "NUMBER"
        }
      }]
    }, "flattened_latest");

    const dataElement = columns.find((column) => column.sourceUid === "ViVJxHnj3zp");
    expect(dataElement?.label).toBe("PKDL cases");
    expect(dataElement?.columnName).toBe("pkdl_cases");
  });

  it("creates separate code and display-name columns for option-set values", () => {
    const columns = generateColumns("dataset", {
      dataSetElements: [{
        dataElement: {
          id: "oZg33kd9taw",
          displayName: "Gender",
          valueType: "TEXT",
          optionSet: {
            id: "pC3N9N77UmT",
            displayName: "Gender options",
            options: [{ id: "maleOption1", code: "M", displayName: "Male" }]
          }
        }
      }]
    }, "flattened_latest");

    const codeColumn = columns.find((column) => column.sourceUid === "oZg33kd9taw" && column.sourceKind === "data_element");
    const displayColumn = columns.find((column) => column.sourceUid === "oZg33kd9taw" && column.sourceKind === "derived");
    expect(codeColumn?.label).toBe("Gender (code)");
    expect(codeColumn?.mapping.displayColumnName).toBe("gender_name");
    expect(displayColumn).toMatchObject({ columnName: "gender_name", label: "Gender", sqlType: "text" });
    expect(displayColumn?.nullable).toBe(true);
  });

  it("reconciles newly generated companion columns on an existing table", () => {
    const statements = reconcileTableColumnsSql("dhis_data", "dhis_example", [{
      ordinal: 1,
      columnName: "gender_name",
      sqlType: "text",
      sourceKind: "derived",
      sourceUid: "oZg33kd9taw",
      stageUid: null,
      repeatPolicy: null,
      nullable: true,
      isFilterable: true,
      label: "Gender",
      mapping: { valueRole: "display", codeColumnName: "gender" }
    }]);

    expect(statements).toEqual([
      'ALTER TABLE "dhis_data"."dhis_example" ADD COLUMN IF NOT EXISTS "gender_name" text'
    ]);
  });
});
