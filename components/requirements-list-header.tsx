"use client"

import { FileText, CheckCircle, Clock, AlertCircle } from "lucide-react"
import { Badge } from "./ui/badge"
import { cn } from "../lib/utils"

type RequirementsListHeaderProps = {
  count: number
  approvedCount?: number
  pendingCount?: number
  rejectedCount?: number
  className?: string
}

export default function RequirementsListHeader({
  count,
  approvedCount = 0,
  pendingCount = 0,
  rejectedCount = 0,
  className
}: RequirementsListHeaderProps) {
  const totalProcessed = approvedCount + rejectedCount
  const completionPercentage = count > 0 ? Math.round((totalProcessed / count) * 100) : 0

  return (
    <div className={cn("bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-6 mb-6", className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center">
            <FileText className="h-6 w-6 text-blue-600" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-gray-900">
              Requirements List
            </h2>
            <p className="text-gray-600 mt-1">
              {count} requirement{count === 1 ? '' : 's'} to review
            </p>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="text-2xl font-bold text-gray-900">
              {completionPercentage}%
            </div>
            <div className="text-sm text-gray-600">
              Complete
            </div>
          </div>

          <div className="flex gap-3">
            <Badge variant="secondary" className="bg-green-100 text-green-800 border-green-200">
              <CheckCircle className="h-3 w-3 mr-1" />
              {approvedCount} Approved
            </Badge>
            <Badge variant="secondary" className="bg-yellow-100 text-yellow-800 border-yellow-200">
              <Clock className="h-3 w-3 mr-1" />
              {pendingCount} Pending
            </Badge>
            <Badge variant="secondary" className="bg-red-100 text-red-800 border-red-200">
              <AlertCircle className="h-3 w-3 mr-1" />
              {rejectedCount} Rejected
            </Badge>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-4">
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-blue-600 h-2 rounded-full transition-all duration-300"
            style={{ width: `${completionPercentage}%` }}
          />
        </div>
      </div>
    </div>
  )
}