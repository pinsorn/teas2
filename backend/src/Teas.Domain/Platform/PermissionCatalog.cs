namespace Teas.Domain.Platform;

/// <summary>One catalog row: the code, its area (the first dotted segment) and whether an agent can ever hold it.</summary>
public sealed record PermissionDef(string Code, string Area, bool AgentForbidden);

/// <summary>
/// SP3 4.5 / 10.4: every permission code, in code. Equal to frontend/src/contract/platform.ts PERMISSION_CODES and SYSTEM_ROLES
/// (RbacMatrixTests parses that frozen file). The migrator syncs both into permissions / role_templates.
/// </summary>
public static class PermissionCatalog
{
    public static IReadOnlyList<string> Codes { get; } =
    [
        "doc.QT.read", "doc.QT.create", "doc.QT.issue", "doc.QT.cancel", "doc.QT.correct", "doc.QT.approve",
        "doc.SO.read", "doc.SO.create", "doc.SO.issue", "doc.SO.cancel", "doc.SO.correct", "doc.SO.approve",
        "doc.DO.read", "doc.DO.create", "doc.DO.issue", "doc.DO.cancel", "doc.DO.correct", "doc.DO.approve",
        "doc.BL.read", "doc.BL.create", "doc.BL.issue", "doc.BL.cancel", "doc.BL.correct", "doc.BL.approve",
        "doc.IV.read", "doc.IV.create", "doc.IV.issue", "doc.IV.cancel", "doc.IV.correct", "doc.IV.approve",
        "doc.TI.read", "doc.TI.create", "doc.TI.issue", "doc.TI.cancel", "doc.TI.correct", "doc.TI.approve",
        "doc.RC.read", "doc.RC.create", "doc.RC.issue", "doc.RC.cancel", "doc.RC.correct", "doc.RC.approve",
        "doc.CN.read", "doc.CN.create", "doc.CN.issue", "doc.CN.cancel", "doc.CN.correct", "doc.CN.approve",
        "doc.DN.read", "doc.DN.create", "doc.DN.issue", "doc.DN.cancel", "doc.DN.correct", "doc.DN.approve",
        "doc.PO.read", "doc.PO.create", "doc.PO.issue", "doc.PO.cancel", "doc.PO.correct", "doc.PO.approve",
        "doc.PB.read", "doc.PB.create", "doc.PB.issue", "doc.PB.cancel", "doc.PB.correct", "doc.PB.approve",
        "doc.PCN.read", "doc.PCN.create", "doc.PCN.issue", "doc.PCN.cancel", "doc.PCN.correct", "doc.PCN.approve",
        "doc.PDN.read", "doc.PDN.create", "doc.PDN.issue", "doc.PDN.cancel", "doc.PDN.correct", "doc.PDN.approve",
        "doc.PV.read", "doc.PV.create", "doc.PV.issue", "doc.PV.cancel", "doc.PV.correct", "doc.PV.approve",
        "doc.WT.read", "doc.EX.read", "doc.EX.create", "doc.EX.issue", "doc.EX.cancel", "doc.EX.correct",
        "doc.EX.approve", "doc.JV.read", "doc.JV.create", "doc.JV.issue", "doc.JV.cancel", "doc.JV.correct",
        "doc.JV.approve", "doc.FA.read", "doc.FA.create", "doc.FA.issue", "doc.FA.cancel", "doc.FA.correct",
        "doc.DP.read", "doc.DP.create", "doc.DP.issue", "doc.DP.cancel", "doc.DP.correct", "doc.PR.read",
        "doc.PR.create", "doc.PR.issue", "doc.PR.cancel", "doc.PR.correct", "doc.PR.pay", "doc.OB.read",
        "doc.OB.create", "doc.OB.issue", "doc.OB.cancel", "doc.OB.correct", "party.read", "party.manage",
        "item.read", "item.manage", "bank.read", "bank.manage", "bank.reconcile", "ledger.read", "ledger.coa.manage",
        "ledger.posting.manage", "ledger.schedule.manage", "ledger.period.close", "ledger.period.reopen",
        "payroll.read", "employee.read", "employee.manage", "audit.read", "settings.manage", "users.manage",
        "report.read", "report.arap.read", "tax.read", "tax.filing.preview", "tax.filing.finalize",
        "tax.settings.manage", "connect.manage",
    ];

    public static IReadOnlyList<PermissionDef> All { get; } =
        [.. Codes.Select(c => new PermissionDef(c, c[..c.IndexOf('.')], AgentRules.AgentForbidden(c)))];

    public static IReadOnlySet<string> CodeSet { get; } = Codes.ToHashSet();

    /// <summary>The three system role templates (a custom role is a row in custom_roles).</summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<string>> SystemRoles { get; } = new Dictionary<string, IReadOnlyList<string>>
    {
        ["operator"] =
        [
            "doc.TI.read", "doc.TI.create", "doc.TI.issue", "doc.IV.read", "doc.IV.create", "doc.IV.issue",
            "doc.BL.read", "doc.BL.create", "doc.BL.issue", "doc.PO.read", "doc.PO.create", "doc.PO.issue",
            "doc.PB.read", "doc.PB.create", "doc.PB.issue", "doc.PV.read", "doc.PV.create", "doc.PV.issue",
            "doc.WT.read", "doc.EX.read", "doc.EX.create", "doc.EX.issue", "doc.PCN.read", "doc.PDN.read", "doc.SO.read",
            "doc.DO.read", "doc.CN.read", "doc.DN.read", "doc.RC.read", "doc.RC.create", "doc.RC.issue", "doc.QT.read",
            "doc.QT.create", "doc.QT.issue", "doc.SO.create", "doc.SO.issue", "doc.DO.create", "doc.DO.issue",
            "party.read", "party.manage", "item.read", "bank.read",
        ],
        ["accountant"] =
        [
            "doc.TI.read", "doc.TI.create", "doc.TI.issue", "doc.IV.read", "doc.IV.create", "doc.IV.issue",
            "doc.BL.read", "doc.BL.create", "doc.BL.issue", "doc.PO.read", "doc.PO.create", "doc.PO.issue",
            "doc.PB.read", "doc.PB.create", "doc.PB.issue", "doc.PB.cancel", "doc.PB.correct", "doc.PCN.read",
            "doc.PCN.create", "doc.PCN.issue", "doc.PCN.cancel", "doc.PCN.correct", "doc.PDN.read", "doc.PDN.create",
            "doc.PDN.issue", "doc.PDN.cancel", "doc.PDN.correct", "doc.PV.read", "doc.PV.create", "doc.PV.issue",
            "doc.WT.read", "doc.PV.cancel", "doc.PV.correct", "doc.PV.approve", "doc.EX.read", "doc.EX.create",
            "doc.EX.issue", "doc.EX.cancel", "doc.EX.correct", "doc.EX.approve", "doc.JV.read", "doc.JV.create",
            "doc.JV.issue", "doc.JV.cancel", "doc.JV.correct", "doc.JV.approve", "doc.OB.read", "doc.OB.create",
            "doc.OB.issue", "doc.OB.cancel", "doc.OB.correct", "doc.FA.read", "doc.FA.create", "doc.FA.issue",
            "doc.FA.cancel", "doc.FA.correct", "doc.DP.read", "doc.DP.create", "doc.DP.issue", "doc.DP.cancel",
            "doc.DP.correct", "doc.PR.read", "doc.PR.create", "doc.PR.issue", "doc.PR.cancel", "doc.PR.correct",
            "doc.PR.pay", "employee.read", "employee.manage", "payroll.read", "doc.PO.cancel", "doc.PO.correct",
            "doc.IV.cancel", "doc.IV.correct", "doc.BL.cancel", "doc.BL.correct", "doc.SO.read", "doc.DO.read",
            "doc.CN.read", "doc.DN.read", "doc.TI.cancel", "doc.TI.correct", "doc.RC.read", "doc.RC.create",
            "doc.RC.issue", "doc.RC.cancel", "doc.RC.correct", "doc.CN.create", "doc.CN.issue", "doc.CN.cancel",
            "doc.CN.correct", "doc.DN.create", "doc.DN.issue", "doc.DN.cancel", "doc.DN.correct", "doc.QT.read",
            "doc.QT.create", "doc.QT.issue", "doc.QT.cancel", "doc.QT.correct", "doc.SO.create", "doc.SO.issue",
            "doc.SO.cancel", "doc.SO.correct", "doc.DO.create", "doc.DO.issue", "doc.DO.cancel", "doc.DO.correct",
            "party.read", "party.manage", "item.read", "item.manage", "ledger.read", "ledger.coa.manage",
            "ledger.posting.manage", "ledger.schedule.manage", "ledger.period.close", "ledger.period.reopen",
            "audit.read", "report.read", "report.arap.read", "bank.read", "bank.manage", "bank.reconcile", "tax.read",
            "tax.filing.preview", "tax.filing.finalize", "tax.settings.manage",
        ],
        ["admin"] =
        [
            "settings.manage", "connect.manage", "tax.settings.manage", "users.manage", "employee.read", "party.read",
            "item.read", "item.manage", "audit.read", "report.read", "report.arap.read", "bank.read", "bank.manage",
        ],
    };
}

/// <summary>SP3 4.5 agent-forbidden rule (ADR-0005), the same rule as the frozen TS `agentForbidden`.</summary>
public static class AgentRules
{
    static readonly HashSet<string> Never =
    [
        "settings.manage", "users.manage", "connect.manage", "ledger.period.close", "ledger.period.reopen", "tax.filing.finalize",
        "tax.settings.manage", "ledger.posting.manage", "ledger.coa.manage", "ledger.schedule.manage",
    ];

    static readonly System.Text.RegularExpressions.Regex DocVerb = new(@"^doc\.[A-Z]+\.(approve|cancel|correct)\z");

    public static bool AgentForbidden(string code) => Never.Contains(code) || DocVerb.IsMatch(code);

    /// <summary>An agent's rights: its key scopes, within what its owner holds now, minus the forbidden codes.</summary>
    public static IReadOnlySet<string> AgentRights(IEnumerable<string> scopes, IReadOnlySet<string> ownerRights) =>
        scopes.Where(s => ownerRights.Contains(s) && !AgentForbidden(s)).ToHashSet();
}
